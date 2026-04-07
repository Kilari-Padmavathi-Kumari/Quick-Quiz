import { pool } from "@quiz-app/db";
import {
  contestAnsweredKey,
  contestMembersKey,
  contestQuestionKey,
  contestScoresKey,
  contestStateKey
} from "@quiz-app/redis";

import { redis } from "./redis.js";

export async function rebuildContestCache(contestId: string, organizationId: string) {
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
            AND organization_id = $2
          LIMIT 1
        `,
        [contestId, organizationId]
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
          SELECT q.seq, q.body, q.option_a, q.option_b, q.option_c, q.option_d, q.correct_option, q.time_limit_sec
          FROM questions q
          JOIN contests c ON c.id = q.contest_id
          WHERE q.contest_id = $1
            AND q.organization_id = $2
            AND c.organization_id = $2
          ORDER BY seq ASC
        `,
        [contestId, organizationId]
      ),
      pool.query<{ user_id: string }>(
        `
          SELECT cm.user_id
          FROM contest_members cm
          JOIN contests c ON c.id = cm.contest_id
          WHERE cm.contest_id = $1
            AND cm.organization_id = $2
            AND c.organization_id = $2
          ORDER BY cm.joined_at ASC
        `,
        [contestId, organizationId]
      ),
      pool.query<{ user_id: string; correct_count: string }>(
        `
          SELECT a.user_id, COUNT(*) FILTER (WHERE a.is_correct = true)::text AS correct_count
          FROM answers a
          JOIN contests c ON c.id = a.contest_id
          WHERE a.contest_id = $1
            AND a.organization_id = $2
            AND c.organization_id = $2
          GROUP BY a.user_id
        `,
        [contestId, organizationId]
      ),
      pool.query<{ seq: number; user_id: string }>(
        `
          SELECT q.seq, a.user_id
          FROM answers a
          JOIN questions q ON q.id = a.question_id
          JOIN contests c ON c.id = a.contest_id
          WHERE a.contest_id = $1
            AND a.organization_id = $2
            AND q.organization_id = $2
            AND c.organization_id = $2
          ORDER BY q.seq ASC
        `,
        [contestId, organizationId]
      )
    ]);

  if (contestResult.rowCount !== 1) {
    throw new Error("Contest not found for cache rebuild");
  }

  const contest = contestResult.rows[0];
  const multi = redis.multi();

  multi.del(contestStateKey(organizationId, contestId));
  multi.del(contestMembersKey(organizationId, contestId));
  multi.del(contestScoresKey(organizationId, contestId));

  if (contest.current_q > 0 && contest.q_started_at) {
    multi.hset(contestStateKey(organizationId, contestId), {
      organization_id: organizationId,
      current_q: String(contest.current_q),
      q_started_at: String(new Date(contest.q_started_at).getTime())
    });
  }

  if (membersResult.rows.length > 0) {
    multi.sadd(
      contestMembersKey(organizationId, contestId),
      ...membersResult.rows.map((member) => member.user_id)
    );
  }

  for (const question of questionsResult.rows) {
    multi.del(contestQuestionKey(organizationId, contestId, question.seq));
    multi.hset(contestQuestionKey(organizationId, contestId, question.seq), {
      organization_id: organizationId,
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
      contestScoresKey(organizationId, contestId),
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
    multi.del(contestAnsweredKey(organizationId, contestId, seq));
    if (userIds.length > 0) {
      multi.sadd(contestAnsweredKey(organizationId, contestId, seq), ...userIds);
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
