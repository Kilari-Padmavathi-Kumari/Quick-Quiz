export type ContestStatus = "draft" | "open" | "live" | "ended" | "cancelled";
export type PrizeRule = "all_correct" | "top_scorer";
export type WalletTransactionType = "credit" | "debit";
export type WalletTransactionReason =
  | "entry_fee"
  | "prize"
  | "refund"
  | "topup"
  | "manual_topup";
export type QuestionOption = "a" | "b" | "c" | "d";

export interface User {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
  wallet_balance: string;
  is_admin: boolean;
  is_banned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Contest {
  id: string;
  title: string;
  status: ContestStatus;
  entry_fee: string;
  max_members: number;
  member_count: number;
  starts_at: string;
  current_q: number;
  q_started_at: string | null;
  ended_at: string | null;
  prize_rule: PrizeRule;
}

export interface Question {
  id: string;
  contest_id: string;
  seq: number;
  body: string;
  option_a: string;
  option_b: string;
  option_c: string;
  option_d: string;
  correct_option: QuestionOption;
  time_limit_sec: number;
  revealed_at: string | null;
}

export interface Answer {
  id: string;
  contest_id: string;
  question_id: string;
  user_id: string;
  chosen_option: QuestionOption;
  is_correct: boolean;
  answered_at: string;
}

export interface ContestMember {
  id: string;
  contest_id: string;
  user_id: string;
  joined_at: string;
  is_winner: boolean;
  prize_amount: string;
}

export interface WalletTransaction {
  id: string;
  user_id: string;
  type: WalletTransactionType;
  reason: WalletTransactionReason;
  amount: string;
  balance_before: string;
  balance_after: string;
  reference_id: string | null;
  created_at: string;
}
