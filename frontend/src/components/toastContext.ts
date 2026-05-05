import { createContext, useContext } from "react";

export type ToastType = "success" | "error" | "warning" | "info";

type ToastAction = {
  label: string;
  onClick: () => void;
};

export type ToastInput = {
  type?: ToastType;
  title: string;
  message?: string;
  durationMs?: number;
  action?: ToastAction;
};

export type ToastRecord = ToastInput & {
  id: string;
  type: ToastType;
};

export type ToastContextValue = {
  showToast: (toast: ToastInput) => string;
  dismissToast: (id: string) => void;
};

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}
