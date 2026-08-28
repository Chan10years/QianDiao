import { randomUUID } from "node:crypto";
import { z } from "zod";

export type SessionId = string & { readonly __brand: "SessionId" };
export type RequestId = string & { readonly __brand: "RequestId" };
export type RecipeId = string & { readonly __brand: "RecipeId" };

const uuidSchema = z.string().uuid();

export const SessionIdSchema = uuidSchema.transform((value) => value as SessionId);
export const RequestIdSchema = uuidSchema.transform((value) => value as RequestId);
export const RecipeIdSchema = uuidSchema.transform((value) => value as RecipeId);

export function createSessionId(): SessionId {
  return randomUUID() as SessionId;
}

export function createRequestId(): RequestId {
  return randomUUID() as RequestId;
}

export function createRecipeId(): RecipeId {
  return randomUUID() as RecipeId;
}

export function parseSessionId(value: unknown): SessionId {
  return SessionIdSchema.parse(value);
}

export function parseRequestId(value: unknown): RequestId {
  return RequestIdSchema.parse(value);
}

export function parseRecipeId(value: unknown): RecipeId {
  return RecipeIdSchema.parse(value);
}
