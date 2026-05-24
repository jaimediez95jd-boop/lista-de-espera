import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBmim1GqYlMvyulfkthxmNPSLH9hEzFQNw",
  authDomain: "palacio-del-pie.firebaseapp.com",
  projectId: "palacio-del-pie",
  storageBucket: "palacio-del-pie.firebasestorage.app",
  messagingSenderId: "1068124921123",
  appId: "1:1068124921123:web:5c90ee74961562450c8096"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
