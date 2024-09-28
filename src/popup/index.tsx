import React from 'react'
import ReactDOM from 'react-dom/client'
import Popup from './Popup'
import '../assets/css/base.css'
import '../assets/css/content.css'

const rootDivId = 'popup-root'
let rootDiv = document.getElementById(rootDivId)

if (!rootDiv) {
  rootDiv = document.createElement('div')
  rootDiv.id = rootDivId
  document.body.appendChild(rootDiv)
}

const root = ReactDOM.createRoot(rootDiv as HTMLElement)

root.render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>
)
