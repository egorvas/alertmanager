FROM node:latest

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

WORKDIR /usr/src/app/bin

EXPOSE 4000

CMD [ "node", "server.js" ]