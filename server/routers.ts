/**
 * Stub type definition for the AppRouter.
 * The actual server is pre-compiled in dist/index.js.
 * This file exists only for TypeScript type inference in the client.
 */
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";

// We declare the router type as `any` since we don't have the full source.
// The compiled dist/index.js handles the actual routing.
export type AppRouter = any;
export type RouterInput = inferRouterInputs<AppRouter>;
export type RouterOutput = inferRouterOutputs<AppRouter>;
