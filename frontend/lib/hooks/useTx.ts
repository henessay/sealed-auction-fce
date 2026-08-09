"use client";

import { useCallback, useState } from "react";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import type { Abi, ContractFunctionArgs, ContractFunctionName } from "viem";

type WriteArgs<
  TAbi extends Abi,
  TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
> = {
  abi: TAbi;
  address: `0x${string}`;
  functionName: TName;
  args?: ContractFunctionArgs<TAbi, "nonpayable" | "payable", TName>;
  value?: bigint;
  gas?: bigint;
};

export function useTx() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastHash, setLastHash] = useState<`0x${string}` | null>(null);

  const execute = useCallback(
    async <
      TAbi extends Abi,
      TName extends ContractFunctionName<TAbi, "nonpayable" | "payable">,
    >(
      config: WriteArgs<TAbi, TName>,
    ) => {
      if (!address) throw new Error("Connect wallet first");
      if (!publicClient) throw new Error("RPC not ready");

      setIsPending(true);
      setError(null);
      try {
        const hash = await writeContractAsync(config as never);
        setLastHash(hash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") {
          throw new Error("Transaction reverted");
        }
        return receipt;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Transaction failed";
        setError(msg);
        throw e;
      } finally {
        setIsPending(false);
      }
    },
    [address, publicClient, writeContractAsync],
  );

  return {
    execute,
    isPending,
    error,
    lastHash,
    clearError: () => setError(null),
  };
}
