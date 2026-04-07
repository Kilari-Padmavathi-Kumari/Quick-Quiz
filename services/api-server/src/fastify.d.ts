import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    user: {
      id: string;
      organization_id: string;
      email: string;
      name: string;
      avatar_url: string | null;
      wallet_balance: string;
      is_admin: boolean;
      is_banned: boolean;
      role: "super_admin" | "organization_admin" | "player" | "pending";
      user_status: "pending" | "active" | "blocked";
    };
  }
}
