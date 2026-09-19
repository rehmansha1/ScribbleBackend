import admin from 'firebase-admin';
import fs from 'node:fs';
import path from 'node:path';

// 1. Support direct JSON string in environment variable (ideal for cloud hosts like Render/Railway)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const creds = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(creds),
    });
    console.log('[Firebase] Initialized with FIREBASE_SERVICE_ACCOUNT environment variable');
  } catch (err) {
    console.error('[Firebase] Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:', err.message);
  }
} else {
  // 2. Support local file path (local development)
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || './serviceAccountKey.json';
  if (fs.existsSync(path.resolve(keyPath))) {
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    console.log(`[Firebase] Initialized with key file: ${keyPath}`);
  } else {
    console.warn(
      `[Firebase] Warning: Service account key not found at "${keyPath}". ` +
      'FCM push notifications and ID token verification will require valid credentials.'
    );
    admin.initializeApp();
  }
}

export default admin;
