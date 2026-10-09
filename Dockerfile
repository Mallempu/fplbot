FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data

# Run as non-root user
RUN addgroup --system appgroup && adduser --system --ingroup appgroup appuser \
    && chown -R appuser:appgroup /app
USER appuser

EXPOSE ${PORT:-3000}

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const p=process.env.PORT||3000;const http=require('http');const r=http.get('http://localhost:'+p+'/api/health',s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1))"

CMD ["node", "src/index.js"]
