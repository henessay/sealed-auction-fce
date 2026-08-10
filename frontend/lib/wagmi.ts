import { createConfig, fallback, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";
import { flareTestnet } from "viem/chains";

import { MULTICALL3_ADDRESS, RPC_URLS } from "./config";

/**
 * viem ships Coston2 without a multicall3 entry even though the canonical
 * deployment is there — adding it lets wagmi batch every useReadContracts
 * into a single eth_call instead of one request per contract read.
 */
export const coston2 = defineChain({
  ...flareTestnet,
  contracts: {
    ...flareTestnet.contracts,
    multicall3: { address: MULTICALL3_ADDRESS },
  },
});

/**
 * Public RPCs rate-limit hard. Each endpoint retries with exponential backoff
 * (viem retries 429/5xx by itself), and `fallback` moves to the next endpoint
 * when one keeps failing. `batch` coalesces calls fired in the same tick into
 * one HTTP request, which is what actually cuts the request count.
 */
const transport = fallback(
  RPC_URLS.map((url) =>
    http(url, {
      batch: { wait: 16 },
      retryCount: 3,
      retryDelay: 300,
      timeout: 20_000,
    }),
  ),
  { retryCount: 0 },
);

export const wagmiConfig = createConfig({
  chains: [coston2],
  connectors: [injected()],
  transports: {
    [coston2.id]: transport,
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
