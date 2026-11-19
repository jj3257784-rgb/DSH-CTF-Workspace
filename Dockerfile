FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 binutils p7zip-full && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN node --input-type=module -e "import fs from 'node:fs'; import {createHash} from 'node:crypto'; import {execFileSync} from 'node:child_process'; const file='knowledge/metadata/tools.json'; const tools=JSON.parse(fs.readFileSync(file)); const packages={'python-local':['/usr/bin/python3','python3-minimal'],'curl-local':['/usr/bin/curl','curl'],'strings-local':['/usr/bin/strings','binutils'],'archive-local':['/usr/lib/p7zip/7z','p7zip-full']}; for(const tool of tools){const pkg=packages[tool.tool_id]; if(!pkg)continue; tool.executable_path=pkg[0]; tool.version=execFileSync('dpkg-query',['-W',pkg[1]],{encoding:'utf8'}).trim().split(/\s+/).pop(); tool.executable_sha256=createHash('sha256').update(fs.readFileSync(pkg[0])).digest('hex')} fs.writeFileSync(file,JSON.stringify(tools))"
RUN chown node:node data
USER node
RUN node --input-type=module -e "import {listTools} from './src/executor/tool-registry.js';if(listTools().filter(t=>t.execution_enabled).length!==8)process.exit(1)" && npm test
ENV DSH_CONTAINER=1
CMD ["node","src/console/start.js"]
