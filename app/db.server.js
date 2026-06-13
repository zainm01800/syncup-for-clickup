import { PrismaClient } from "@prisma/client";
import { PrismaNeonHttp } from "@prisma/adapter-neon";

function createClient() {
  const adapter = new PrismaNeonHttp(process.env.DATABASE_URL);
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
