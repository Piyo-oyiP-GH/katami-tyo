// /api/p/:pid/* の入口。ここを通るものは全部、参加者の確認を受ける。
import { Hono } from "hono";
import { itemRoutes } from "./items";
import { peopleRoutes } from "./people";
import { searchRoutes } from "./search";
import { AppEnv, requireMember } from "./session";

export const projectRoutes = new Hono<AppEnv>();

projectRoutes.use("*", requireMember);
projectRoutes.route("/items", itemRoutes);
projectRoutes.route("/search", searchRoutes);
projectRoutes.route("/", peopleRoutes);

projectRoutes.all("*", (c) => c.json({ error: "not_found" }, 404));
