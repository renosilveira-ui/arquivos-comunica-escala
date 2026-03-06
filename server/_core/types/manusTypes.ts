// server/_core/types/manusTypes.ts — Tipos da API OAuth Manus
export interface ExchangeTokenRequest {
  clientId: string;
  grantType: string;
  code: string;
  redirectUri: string;
}

export interface ExchangeTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}

export interface GetUserInfoResponse {
  id: string;
  openId: string;
  name: string;
  email: string;
  avatar?: string;
  loginMethod?: string;
  platforms?: string[];
}

export interface GetUserInfoWithJwtRequest {
  jwt: string;
}

export interface GetUserInfoWithJwtResponse extends GetUserInfoResponse {}
