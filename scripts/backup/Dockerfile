# The backup job's image: a Postgres client matching the server, age for encryption, an S3 client,
# and node to run plan.mjs. Deliberately holds no application code — it copies data, it does not run it.

FROM alpine:3.21

RUN apk add --no-cache \
      postgresql16-client \
      age \
      aws-cli \
      nodejs \
      tar \
      ca-certificates

WORKDIR /opt/backup
COPY plan.mjs plan.d.mts backup.mjs verify.mjs verify.d.mts restore-drill.mjs ./

# Unprivileged: this container reads the database and the attachments volume and writes to a bucket.
RUN addgroup -g 10001 backup && adduser -D -u 10001 -G backup backup
USER 10001:10001

ENTRYPOINT ["node", "/opt/backup/backup.mjs"]
