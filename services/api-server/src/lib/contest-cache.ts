import { pool } from "@quiz-app/db";
import {
  contestAnsweredKey,
  contestMembersKey,
  contestQuestionKey,
  contestScoresKey,
  contestStateKey
} from "@quiz-app/redis";

import { redis } from "./redis.js";

export async function rebuildContestCache(contestId: string) {
  const [contestResult, questionsResult, membersResult, scoresResult, answeredResult] =
    await Promise.all([
      pool.query<{
        current_q: number;
        q_started_at: string | null;
        status: string;
      }>(
        `
          SELECT current_q, q_started_at, status
          FROM contests
          WHERE id = $1
          LIMIT 1
        `,
        [contestId]
      ),
      pool.query<{
        seq: number;
        body: string;
        option_a: string;
        option_b: string;
        option_c: string;
        option_d: string;
        correct_option: string;
        time_limit_sec: number;
      }>(
        `
          SELECT seq, body, option_a, option_b, option_c, option_d, correct_option, time_limit_sec
          FROM questions
          WHERE contest_id = $1
          ORDER BY seq ASC
        `,
        [contestId]
      ),
      pool.query<{ user_id: string }>(
        "SELECT user_id FROM contest_members WHERE contest_id = $1 ORDER BY joined_at ASC",
        [contestId]
      ),
      pool.query<{ user_id: string; correct_count: string }>(
        `
          SELECT user_id, COUNT(*) FILTER (WHERE is_correct = true)::text AS correct_count
          FROM answers
          WHERE contest_id = $1
          GROUP BY user_id
        `,
        [contestId]
      ),
      pool.query<{ seq: number; user_id: string }>(
        `
          SELECT q.seq, a.user_id
          FROM answers a
          JOIN questions q ON q.id = a.question_id
          WHERE a.contest_id = $1
          ORDER BY q.seq ASC
        `,
        [contestId]
      )
    ]);

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found for cache rebuild");
  }

  const contest = contestResult.rows[0];
  const multi = redis.multi();

  multi.del(contestStateKey(contestId));
  multi.del(contestMembersKey(contestId));
  multi.del(contestScoresKey(contestId));

  if (contest.current_q > 0 && contest.q_started_at) {
    multi.hset(contestStateKey(contestId), {
      current_q: String(contest.current_q),
      q_started_at: String(new Date(contest.q_started_at).getTime())
    });
  }

  if (membersResult.rows.length > 0) {
    multi.sadd(
      contestMembersKey(contestId),
      ...membersResult.rows.map((member) => member.user_id)
    );
  }

  for (const question of questionsResult.rows) {
    multi.del(contestQuestionKey(contestId, question.seq));
    multi.hset(contestQuestionKey(contestId, question.seq), {
      seq: String(question.seq),
      body: question.body,
      option_a: question.option_a,
      option_b: question.option_b,
      option_c: question.option_c,
      option_d: question.option_d,
      correct_option: question.correct_option,
      time_limit_sec: String(question.time_limit_sec)
    });
  }

  if (scoresResult.rows.length > 0) {
    multi.hset(
      contestScoresKey(contestId),
      ...scoresResult.rows.flatMap((row) => [row.user_id, row.correct_count])
    );
  }

  const answeredBySeq = new Map<number, string[]>();

  for (const row of answeredResult.rows) {
    const existing = answeredBySeq.get(row.seq) ?? [];
    existing.push(row.user_id);
    answeredBySeq.set(row.seq, existing);
  }

  for (const [seq, userIds] of answeredBySeq.entries()) {
    multi.del(contestAnsweredKey(contestId, seq));
    if (userIds.length > 0) {
      multi.sadd(contestAnsweredKey(contestId, seq), ...userIds);
    }
  }

  await multi.exec();

  return {
    contestId,
    status: contest.status,
    questionCount: questionsResult.rows.length,
    memberCount: membersResult.rows.length
  };
}
