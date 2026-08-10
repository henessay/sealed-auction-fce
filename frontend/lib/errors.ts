"use client";

import { TeeResultUnavailableError } from "@/lib/tee/proxy";

/** Thrown for form validation: the message is already user-facing. */
export class UserInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserInputError";
  }
}

export type FriendlyError = {
  /** One sentence a non-developer can act on. */
  message: string;
  /** Raw text, shown only behind a "details" toggle. */
  details: string;
  /** Rate limiting is transient — callers may keep the UI in a retry state. */
  transient: boolean;
};

/** Contract revert strings → what actually went wrong, in plain words. */
const REVERT_MESSAGES: Array<[RegExp, string]> = [
  [/auction not open/i, "This auction is no longer open."],
  [/bidding closed/i, "The deadline has passed — bidding is closed."],
  [/bidding still open/i, "The deadline has not passed yet."],
  [/auction not closable/i, "This auction cannot be closed in its current state."],
  [/auction not closing/i, "This auction is not awaiting settlement."],
  [/not seller/i, "Only the seller can do that."],
  [/bids exist/i, "The auction already has bids, so it can no longer be cancelled."],
  [/no such auction/i, "That auction does not exist."],
  [/below reserve/i, "The winning bid is below the reserve price."],
  [/lot required/i, "Add a description for the lot."],
  [/zero lot amount/i, "The lot amount must be greater than zero."],
  [/zero pay token|zero lot token/i, "A token address is missing."],
  [/deadline in the past/i, "Pick a deadline in the future."],
  [/lot escrow failed/i, "The lot could not be moved into escrow."],
  [/TEE address not set/i, "The contract has no registered TEE key yet."],
  [/bad TEE signature/i, "The TEE signature did not verify on-chain."],
  [/TEE reported failure/i, "The TEE reported a failure for this instruction."],
  [/result not for this contract/i, "That TEE result belongs to another contract."],
  [
    /payment failed|insufficient allowance|exceeds allowance|transfer amount exceeds/i,
    "The winner has not approved enough pay tokens for this contract.",
  ],
  [/exceeds balance|insufficient balance/i, "Not enough tokens in the wallet."],
  [
    /CannotTransferToSelf|0xdad89dca/i,
    "FXRP refuses transfers to yourself — buyer and seller must be different wallets.",
  ],
  [
    /ReentrancySentryOOG/i,
    "FXRP rejected the gas limit its own estimate produced. Retry — the app pins a higher limit.",
  ],
  [/reentrant/i, "The contract blocked a re-entrant call."],
  [/ERC721.*not owner|not owner nor approved|caller is not token owner/i,
    "This wallet does not own that NFT, or has not approved it."],
];

function rawText(error: unknown): string {
  if (error instanceof Error) {
    const extra = [
      (error as { shortMessage?: string }).shortMessage,
      (error as { details?: string }).details,
      (error as { metaMessages?: string[] }).metaMessages?.join("\n"),
      (error as { cause?: unknown }).cause instanceof Error
        ? ((error as { cause: Error }).cause.message ?? "")
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    return [error.message, extra].filter(Boolean).join("\n");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Turn anything thrown by viem/wagmi/fetch into something worth showing.
 * The raw text is preserved separately so debugging is still possible.
 */
export function friendlyError(error: unknown, fallback: string): FriendlyError {
  const details = rawText(error);

  if (error instanceof UserInputError) {
    return { message: error.message, details: "", transient: false };
  }

  if (error instanceof TeeResultUnavailableError) {
    return {
      message:
        "The TEE did not answer in time — the extension may be unreachable.",
      details,
      transient: true,
    };
  }

  if (/rate limit|429|too many requests/i.test(details)) {
    return {
      message: "The network is busy — retrying. Give it a moment.",
      details,
      transient: true,
    };
  }
  if (/user rejected|user denied|ACTION_REJECTED|4001/i.test(details)) {
    return {
      message: "You rejected the request in your wallet.",
      details,
      transient: false,
    };
  }
  if (/insufficient funds|gas required exceeds/i.test(details)) {
    return {
      message: "Not enough C2FLR to pay for gas.",
      details,
      transient: false,
    };
  }
  if (/chain mismatch|does not match the target chain|wrong network/i.test(details)) {
    return {
      message: "Your wallet is on the wrong network — switch to Coston2.",
      details,
      transient: false,
    };
  }
  if (/timed out|timeout|network error|failed to fetch/i.test(details)) {
    return {
      message: "The network did not respond — retrying may help.",
      details,
      transient: true,
    };
  }

  for (const [pattern, message] of REVERT_MESSAGES) {
    if (pattern.test(details)) return { message, details, transient: false };
  }

  return { message: fallback, details, transient: false };
}
