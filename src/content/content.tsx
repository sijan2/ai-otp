import ReactDOM from 'react-dom/client'
import ContentApp from './ContentApp'

let root: ReactDOM.Root | null = null

let isAppInjected = false

function injectApp() {
  if (!isAppInjected) {
    const rootDiv = document.createElement('div')
    rootDiv.id = 'extension-root'
    document.body.appendChild(rootDiv)
    root = ReactDOM.createRoot(rootDiv)
    isAppInjected = true
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message)
  if (message.action === 'processVerification') {
    const { messageId, verificationResponse } = message.data
    console.log('Showing OTP:', verificationResponse)
    if (!root) {
      injectApp()
    }
    console.log('Rendering ContentApp with OTP:', messageId)
    root?.render(<ContentApp otp={verificationResponse.code} />)
    sendResponse({ status: 'OTP displayed' })
  } else if (message.action === 'checkContentScriptReady') {
    console.log('Received checkContentScriptReady message')
    chrome.runtime.sendMessage({ action: 'contentScriptReady' })
    sendResponse({ status: 'Content script is ready' })
  }
  return true // Indicates that the response is sent asynchronously
})

// Inform background script that content script is ready
console.log('Content script loaded, sending contentScriptReady message')
chrome.runtime.sendMessage({ action: 'contentScriptReady' })
