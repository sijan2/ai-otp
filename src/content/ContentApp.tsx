import React, { useState, useEffect } from 'react'

interface ContentAppProps {
  otp: string
}

const ContentApp: React.FC<ContentAppProps> = ({ otp }) => {
  const [otps, setOtp] = useState(otp)
  const [visible, setVisible] = useState(true)
  const [copySuccess, setCopySuccess] = useState('')

  useEffect(() => {
    console.log('OTP updated in ContentApp:', otp)
    setOtp(otp)
    setVisible(true)

    const timer = setTimeout(() => {
      setVisible(false)
    }, 5000)

    return () => {
      clearTimeout(timer)
      console.log('Timer cleared for OTP:', otp)
    }
  }, [otp])

  const handleCopyClick = () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(otps)
        .then(() => {
          console.log('OTP copied to clipboard on button click:', otps)
          setCopySuccess('Copied to clipboard!')
        })
        .catch((err) => {
          console.error('Failed to copy OTP on button click:', err)
        })
    } else {
      // Fallback method for older browsers
      const textArea = document.createElement('textarea')
      textArea.value = otps
      textArea.style.position = 'fixed' // Prevent scrolling to bottom of page in Microsoft Edge.
      document.body.appendChild(textArea)
      textArea.focus()
      textArea.select()
      try {
        const successful = document.execCommand('copy')
        if (successful) {
          console.log(
            'Fallback: OTP copied to clipboard on button click:',
            otps
          )
          setCopySuccess('Copied to clipboard!')
        } else {
          console.error('Fallback: Failed to copy OTP on button click')
        }
      } catch (err) {
        console.error('Fallback: Error copying OTP on button click:', err)
      }
      document.body.removeChild(textArea)
    }
  }

  if (!visible) return null

  return (
    <div
      style={{
        position: 'fixed',
        top: '20px',
        right: '20px',
        backgroundColor: '#fff',
        color: '#333',
        padding: '16px 24px',
        borderRadius: '12px',
        boxShadow: '0 8px 12px rgba(0, 0, 0, 0.15)',
        fontFamily: 'Arial, sans-serif',
        fontSize: '14px',
        zIndex: 2147483647,
        maxWidth: '300px',
      }}
    >
      <p style={{ margin: '0 0 8px', fontWeight: 'bold', fontSize: '16px' }}>
        OTP Received
      </p>
      <p
        style={{
          margin: '0 0 12px',
          fontSize: '24px',
          letterSpacing: '2px',
          textAlign: 'center',
        }}
      >
        {otp}
      </p>
      <button
        onClick={handleCopyClick}
        style={{
          display: 'block',
          width: '100%',
          padding: '10px',
          backgroundColor: '#4CAF50',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer',
          fontSize: '16px',
        }}
      >
        Copy OTP
      </button>
      {copySuccess && (
        <p style={{ color: 'green', marginTop: '8px', textAlign: 'center' }}>
          {copySuccess}
        </p>
      )}
    </div>
  )
}

export default ContentApp
