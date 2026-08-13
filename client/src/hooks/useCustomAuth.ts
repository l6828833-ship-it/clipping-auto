import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { useEffect } from "react";

export function useCustomAuth() {
  const { data: user, isLoading } = trpc.auth.me.useQuery();
  const isAuthenticated = !!user;
  return { user, isLoading, isAuthenticated };
}

export function useRequireAuth() {
  const { user, isLoading } = useCustomAuth();
  const [, navigate] = useLocation();
  useEffect(() => {
    if (!isLoading && !user) {
      navigate("/login");
    }
  }, [user, isLoading, navigate]);
  return { user, isLoading };
}

export function useRedirectIfAuth() {
  const { user, isLoading } = useCustomAuth();
  const [, navigate] = useLocation();
  useEffect(() => {
    if (!isLoading && user) {
      navigate("/dashboard");
    }
  }, [user, isLoading, navigate]);
  return { user, isLoading };
}
