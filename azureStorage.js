const { BlobServiceClient } = require('@azure/storage-blob');
const path = require('path');
const fs = require('fs');

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER_NAME || 'profile-pictures';

let blobServiceClient = null;
let containerClient = null;
let isAzureConfigured = !!connectionString;

if (isAzureConfigured) {
  try {
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);
  } catch (error) {
    console.error('Failed to initialize Azure Blob Storage client:', error.message);
    isAzureConfigured = false;
  }
} else {
  console.warn('Azure Storage Connection String not set. Falling back to local disk storage.');
}

// Ensure local upload directory exists (always ensure it exists so we can fallback dynamically if needed)
const localUploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localUploadDir)) {
  fs.mkdirSync(localUploadDir, { recursive: true });
}

/**
 * Uploads a profile picture buffer.
 * @param {string|number} userId - The user ID
 * @param {Buffer} buffer - The file buffer
 * @param {string} originalName - The original file name
 * @param {string} mimeType - The mime type of the file
 * @param {string} hostUrl - The server host URL (for local fallback)
 * @returns {Promise<string>} The URL of the uploaded image
 */
async function uploadProfilePicture(userId, buffer, originalName, mimeType, hostUrl) {
  const extension = path.extname(originalName) || '.jpg';
  const blobName = `user-${userId}-${Date.now()}${extension}`;

  if (isAzureConfigured && containerClient) {
    try {
      // 1. Ensure container exists
      await containerClient.createIfNotExists({
        access: 'blob', // make blob publicly accessible so it can be viewed in browser
      });

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      
      // 2. Upload buffer
      await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: {
          blobContentType: mimeType,
        }
      });

      // 3. Return Azure Blob URL
      return blockBlobClient.url;
    } catch (azureError) {
      console.error('Azure upload failed, falling back to local storage:', azureError.message);
      // Fall through to local fallback
    }
  }

  // Fallback: local storage
  const localPath = path.join(localUploadDir, blobName);
  await fs.promises.writeFile(localPath, buffer);
  
  // Return local server URL
  return `${hostUrl}/uploads/${blobName}`;
}

/**
 * Deletes a profile picture.
 * @param {string} pictureUrl - The URL of the profile picture to delete
 * @returns {Promise<void>}
 */
async function deleteProfilePicture(pictureUrl) {
  if (!pictureUrl) return;

  // Check if it's an Azure Blob URL
  // Typically contains blob.core.windows.net
  const isAzureUrl = pictureUrl.includes('blob.core.windows.net');

  if (isAzureUrl && isAzureConfigured && containerClient) {
    try {
      // Extract blob name from URL
      // Azure URL format: https://<account>.blob.core.windows.net/<container>/<blobName>
      const urlObj = new URL(pictureUrl);
      const pathname = urlObj.pathname; // /containerName/blobName
      const parts = pathname.split('/');
      const blobName = parts[parts.length - 1];

      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.deleteIfExists();
      console.log(`Deleted Azure Blob: ${blobName}`);
      return;
    } catch (error) {
      console.error('Failed to delete blob from Azure Storage:', error.message);
    }
  }

  // Default fallback: assume local file deletion
  try {
    const filename = path.basename(pictureUrl);
    const localPath = path.join(localUploadDir, filename);
    if (fs.existsSync(localPath)) {
      await fs.promises.unlink(localPath);
      console.log(`Deleted local file: ${filename}`);
    }
  } catch (error) {
    console.error('Failed to delete local fallback file:', error.message);
  }
}

module.exports = {
  uploadProfilePicture,
  deleteProfilePicture,
  isAzureConfigured
};
