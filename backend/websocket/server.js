const express = require('express')
const http = require('http')
const WebSocket = require('ws')

const app = express()
const server = http.createServer(app)
const wss = new WebSocket.Server({ server })

app.use(express.json())

wss.on('connection', (ws) => {
  console.log('Client connected')

  ws.on('message', (message) => {
    console.log('Received:', message)
    ws.send(`${message}`)
  })

  ws.on('close', () => {
    console.log('Client disconnected')
  })
})

app.post('/', (req, res) => {
  console.log('Received POST request:', req.body)

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(req.body)) // Send the body as a JSON string
    }
  })

  res.status(200).send('Data forwarded to WebSocket clients')
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`)
})
