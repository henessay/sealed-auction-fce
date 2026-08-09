export type TeePublicKey = {
  x: `0x${string}`;
  y: `0x${string}`;
};

export type TeeInfoResponse = {
  teeInfo: { publicKey: TeePublicKey; chainId: number };
  machineData: {
    extensionId: `0x${string}`;
    initialOwner: `0x${string}`;
    codeHash: `0x${string}`;
    platform: `0x${string}`;
    publicKey: TeePublicKey;
    governanceHash: `0x${string}`;
  };
  attestation: string;
  proxySignature: `0x${string}`;
};

export type ActionResultPayload = {
  data: `0x${string}`;
  id: `0x${string}`;
  submissionTag: string;
  status: number;
  log?: string;
};

export type ActionResponse = {
  result: ActionResultPayload;
  signature: `0x${string}`;
};
