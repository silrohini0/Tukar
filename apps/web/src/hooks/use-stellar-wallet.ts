"use client";

import { useCallback, useState } from "react";
import { connectWallet, signTx } from "@/lib/stellar-wallet";
import { fetchXlmBalance, buildPaymentXdr, submitSignedTx } from "@/lib/stellar-sdk";

interface WalletState {
  address: string | null;
  balance: string | null;
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useWallet() {
  const [state, setState] = useState<WalletState>({
    address: null,
    balance: null,
    isConnected: false,
    isLoading: false,
    error: null,
  });

  const refreshBalance = useCallback(async (address?: string) => {
    const target = address ?? state.address;
    if (!target) return;

    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const balance = await fetchXlmBalance(target);
      setState((prev) => ({ ...prev, balance, isLoading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to fetch balance",
      }));
    }
  }, [state.address]);

  const connect = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const address = await connectWallet();
      const balance = await fetchXlmBalance(address);
      setState({
        address,
        balance,
        isConnected: true,
        isLoading: false,
        error: null,
      });
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Failed to connect wallet",
      }));
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({
      address: null,
      balance: null,
      isConnected: false,
      isLoading: false,
      error: null,
    });
  }, []);

  const sendXlm = useCallback(
    async (to: string, amount: string): Promise<{ hash: string }> => {
      if (!state.address) {
        throw new Error("Wallet not connected");
      }

      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        const unsignedXdr = await buildPaymentXdr(state.address, to, amount);
        const signedXdr = await signTx(unsignedXdr);
        const result = await submitSignedTx(signedXdr);
        const balance = await fetchXlmBalance(state.address);
        setState((prev) => ({ ...prev, balance, isLoading: false }));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to send transaction";
        setState((prev) => ({ ...prev, isLoading: false, error: message }));
        throw new Error(message);
      }
    },
    [state.address],
  );

  return {
    address: state.address,
    balance: state.balance,
    isConnected: state.isConnected,
    isLoading: state.isLoading,
    error: state.error,
    connect,
    disconnect,
    refreshBalance,
    sendXlm,
  };
}
