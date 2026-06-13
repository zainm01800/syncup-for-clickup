import { PrismaClient } from "@prisma/client";
import { neon } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";

function createClient() {
  const sql = neon(process.env.DATABASE_URL);
  const adapter = new PrismaNeon(sql);
  return new PrismaClient({ adapter });
}

let prisma;

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
  prisma = global.prismaGlobal;
} else {
  prisma = createClient();
}

export default prisma;
