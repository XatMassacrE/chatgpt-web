import express from 'express'
import axios, { AxiosError, AxiosRequestConfig, AxiosResponse } from 'axios'
import type { RequestProps, StreamMessage } from './types'
import type { ChatMessage } from './chatgpt'
import { chatConfig, chatReplyProcess, currentModel } from './chatgpt'
import { auth } from './middleware/auth'
import { limiter } from './middleware/limiter'
import { isNotEmptyString } from './utils/is'

const AZURE_API_URL = process.env.AZURE_API_URL
const AZURE_API_KEY = process.env.AZURE_API_KEY

const app = express()
const router = express.Router()

app.use(express.static('public'))
app.use(express.json())

app.all('*', (_, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', 'authorization, Content-Type')
  res.header('Access-Control-Allow-Methods', '*')
  next()
})

const handleStreamResponse = (res: any, streamData: any) => {
  streamData.on('data', (data: Buffer) => {
    const decodedData = data.toString('utf8')
    if (decodedData.includes('data: [DONE]')) {
      res.write(`${decodedData}\n`)
    } else {
      res.write(data)
    }
  })

  streamData.on('end', () => {
    res.end()
  })
}

router.post('/chat-sse', [auth, limiter], async (req, res) => {
  const { csid, prompt, options = {}, systemMessage } = req.body as RequestProps
  const headers: { [key: string]: string } = {
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Content-Type': 'text/event-stream',
    'Access-Control-Allow-Origin': '*',
  }
  let ncsid: string = csid
  if (!csid) {
    ncsid = (Date.now()).toString(36)
    headers['Conversation-ID'] = ncsid
  }

  res.writeHead(200, headers)

  try {
    options.conversationId = ncsid

    const apiVersion = '2023-03-15-preview'
    const azureApiKey = AZURE_API_KEY
    const resourceId = 'ywt-chatgpt-instance'
    const endpoint = `https://${resourceId}.openai.azure.com`
    const deploymentMapping = 'gpt35'
    const url = `${endpoint}/openai/deployments/${deploymentMapping}/chat/completions?api-version=${apiVersion}`
    const headers = {
      'api-key': azureApiKey,
      'Content-Type': 'application/json'
    }
    const config = { headers }
    config['responseType'] = 'stream'

    const data = {
      "messages": [
        {
          "role": "system",
          "content": "You are an AI assistant that helps people find information."
        },
        {
          "role": "user",
          "content": prompt
        },
      ],
      "temperature": 0.7,
      "top_p": 0.95,
      "frequency_penalty": 0,
      "presence_penalty": 0,
      "max_tokens": 1000,
      "stop": null,
      "stream": true
    }
    
    const openaiResponse = await axios.post(url, data, config)
    if (!openaiResponse) {
      res.status(500).json({ message: 'Error: Failed to retrieve response from Azure OpenAI.' })
      return
    }
  
    // for (const [key, value] of Object.entries(openaiResponse.headers)) {
    //   res.setHeader(key, value)
    // }
  
    if (openaiResponse.status >= 200 && openaiResponse.status < 300) {
      res.status(openaiResponse.status)
      handleStreamResponse(res, openaiResponse.data)
    } else {
      res.status(openaiResponse.status).send(openaiResponse.data)
    }
  }
  catch (error) {
    res.write(JSON.stringify(error))
  }
  finally {
    res.end()
  }
})

router.post('/chat-process', [auth, limiter], async (req, res) => {
  res.setHeader('Content-type', 'application/octet-stream')

  try {
    const { prompt, options = {}, systemMessage, temperature, top_p } = req.body as RequestProps
    let firstChunk = true
    await chatReplyProcess({
      message: prompt,
      lastContext: options,
      process: (chat: ChatMessage) => {
        res.write(firstChunk ? JSON.stringify(chat) : `\n${JSON.stringify(chat)}`)
        firstChunk = false
      },
      systemMessage,
      temperature,
      top_p,
    })
  }
  catch (error) {
    res.write(JSON.stringify(error))
  }
  finally {
    res.end()
  }
})

router.post('/config', auth, async (req, res) => {
  try {
    const response = await chatConfig()
    res.send(response)
  }
  catch (error) {
    res.send(error)
  }
})

router.post('/session', async (req, res) => {
  try {
    const AUTH_SECRET_KEY = process.env.AUTH_SECRET_KEY
    const hasAuth = isNotEmptyString(AUTH_SECRET_KEY)
    res.send({ status: 'Success', message: '', data: { auth: hasAuth, model: currentModel() } })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

router.post('/verify', async (req, res) => {
  try {
    const { token } = req.body as { token: string }
    if (!token)
      throw new Error('Secret key is empty')

    if (process.env.AUTH_SECRET_KEY !== token)
      throw new Error('密钥无效 | Secret key is invalid')

    res.send({ status: 'Success', message: 'Verify successfully', data: null })
  }
  catch (error) {
    res.send({ status: 'Fail', message: error.message, data: null })
  }
})

app.use('', router)
app.use('/api', router)
app.set('trust proxy', 1)

app.listen(3002, () => globalThis.console.log('Server is running on port 3002'))
