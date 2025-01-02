// ../lib/setup.ts

import axios from 'axios'

const GMAIL_API_BASE_URL = 'https://www.googleapis.com/gmail/v1'

// Define an interface for the watch response
export interface WatchResponse {
  historyId: string
  expiration: string
}

// Function to set up Gmail watch on the 'otp' label
export const setupGmailWatch = async (
  accessToken: string
): Promise<WatchResponse> => {
  try {
    // Fetch all labels to find the 'otp' label
    const labelsResponse = await axios.get(
      `${GMAIL_API_BASE_URL}/users/me/labels`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    )

    const labels = labelsResponse.data.labels
    if (!labels) {
      throw new Error('No labels found.')
    }

    // Find the label named 'otp'
    const otpLabel = labels.find((label: any) => label.name === 'otp')

    let labelId: string

    if (otpLabel && otpLabel.id) {
      labelId = otpLabel.id
      console.log(`Found label 'otp' with ID: ${labelId}`)
    } else {
      // If the 'otp' label doesn't exist, create it
      console.log("Label 'otp' not found. Creating it.")
      labelId = await createLabel(accessToken, 'otp')
    }

    // Set up the watch on the 'otp' label
    const watchRequestBody = {
      topicName: 'projects/sijan-420305/topics/otp',
      labelIds: [labelId],
    }

    const watchResponse = await axios.post(
      `${GMAIL_API_BASE_URL}/users/me/watch`,
      watchRequestBody,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    console.log('Watch set up successfully:', watchResponse.data)

    // Return the watch response data
    const responseData: WatchResponse = {
      historyId: watchResponse.data.historyId,
      expiration: watchResponse.data.expiration,
    }

    return responseData
  } catch (error: any) {
    const errorMessage = error.response?.data || error.message
    console.error('Failed to set up Gmail watch:', errorMessage)
    throw new Error(JSON.stringify(errorMessage))
  }
}

// Helper function to create a new label
const createLabel = async (
  accessToken: string,
  labelName: string
): Promise<string> => {
  try {
    const label = {
      name: labelName,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    }

    const response = await axios.post(
      `${GMAIL_API_BASE_URL}/users/me/labels`,
      label,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    )

    console.log(`Label '${labelName}' created successfully.`)
    return response.data.id // Return the labelId
  } catch (error: any) {
    const errorMessage = error.response?.data || error.message
    console.error('Error creating label:', errorMessage)
    throw new Error(JSON.stringify(errorMessage))
  }
}
