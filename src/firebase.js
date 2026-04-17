import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
  apiKey: 'AIzaSyDTX8K1miiFBCJreH8kCwqBD3AqfqzhMEg',
  authDomain: 'urbanrisk.firebaseapp.com',
  projectId: 'urbanrisk',
  storageBucket: 'urbanrisk.firebasestorage.app',
  messagingSenderId: '44754537815',
  appId: '1:44754537815:web:7c78d9a760860a67b88212',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

export { app, auth, db, storage };
