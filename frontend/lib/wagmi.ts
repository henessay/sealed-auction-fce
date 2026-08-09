import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { flareTestnet } from "viem/chains";

import { RPC_URL } from "./config";

export const wagmiConfig = createConfig({
  chains: [flareTestnet],
  connectors: [injected()],
  transports: {
    [flareTestnet.id]: http(RPC_URL),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
