# Environment variables declared in this file are NOT automatically loaded by Prisma.
# Please add `import "dotenv/config";` to your `prisma.config.ts` file, or use the Prisma CLI with Bun
# to load environment variables from .env files: https://pris.ly/prisma-config-env-vars.

# Prisma supports the native connection string format for PostgreSQL, MySQL, SQLite, SQL Server, MongoDB and CockroachDB.
# See the documentation for all the connection string options: https://pris.ly/d/connection-strings

# The following `prisma+postgres` URL is similar to the URL produced by running a local Prisma Postgres
# server with the `prisma dev` CLI command, when not choosing any non-default ports or settings. The API key, unlike the
# one found in a remote Prisma Postgres URL, does not contain any sensitive information.

REDIS_URL="rediss://default:gQAAAAAAAkkuAAIgcDI4Zjc1NGJjM2FlOTE0ZGMyYWEwNGE5OGZjYzg3YTZmOQ@clear-longhorn-149806.upstash.io:6379"
DATABASE_DIRECT_URL="postgresql://neondb_owner:npg_e1hfyZI4oXuW@ep-fragrant-waterfall-aboqr5a5.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
DATABASE_URL="postgresql://neondb_owner:npg_e1hfyZI4oXuW@ep-fragrant-waterfall-aboqr5a5-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
KAFKA_BROKER=localhost:9092


FIXED_OTP=123456
isProduction=false

JWT_SECRET_KEY=CJsywCDHTtCJsywCJsywCDHTtCJsyw
REFRESH_JWT_SECRET_KEY=CJsywCDHTtCJsywCJsywCDHTtCJsywREFRESH
JWT_SECRET=CJsywCDHTtCJsywCJsywCDHTtCJsyw

SECRET=Good Things Take Time kkllll!!!!
ADMINSECRET=Good Things Take Time  asdf !!!!

# LiveKit Setup
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=this_is_a_very_long_secret_key_of_32_chars
