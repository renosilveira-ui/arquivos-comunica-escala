// lib/_core/auth.ts — Gerenciamento de sessão/token para o app mobile
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

const SESSION_TOKEN_KEY = "session_token";
const USER_INFO_KEY = "user_info";

export interface User {
  id: number;
  name: string | null;
  email: string | null;
  role: "admin" | "manager" | "doctor" | "nurse" | "tech";
}

// --- Token ---

async function secureGet(key: string): Promise<string | null> {
  if (Platform.OS === "web") {
    return AsyncStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function secureSet(key: string, value: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.setItem(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value);
}

async function secureRemove(key: string): Promise<void> {
  if (Platform.OS === "web") {
    await AsyncStorage.removeItem(key);
    return;
  }
  await SecureStore.deleteItemAsync(key);
}

export async function getSessionToken(): Promise<string | null> {
  return secureGet(SESSION_TOKEN_KEY);
}

export async function setSessionToken(token: string): Promise<void> {
  return secureSet(SESSION_TOKEN_KEY, token);
}

export async function removeSessionToken(): Promise<void> {
  return secureRemove(SESSION_TOKEN_KEY);
}

// --- User Info (cache local) ---

export async function getUserInfo(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_INFO_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export async function setUserInfo(user: User): Promise<void> {
  await AsyncStorage.setItem(USER_INFO_KEY, JSON.stringify(user));
}

export async function clearUserInfo(): Promise<void> {
  await AsyncStorage.removeItem(USER_INFO_KEY);
}
