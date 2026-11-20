import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { flowEval } from "./flow-eval.mjs";

const database=new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys=ON");
database.exec(readFileSync(new URL("../bot/schema.sql",import.meta.url),"utf8"));
const db={
  prepare(sql) {
    return {bind(...args) {
      const run=async()=>{
        const results=database.prepare(sql).all(...args);
        return {results,meta:database.prepare("SELECT changes() AS changes").get()};
      };
      return {run,all:run,first:async()=>(await run()).results[0] ?? null};
    }};
  },
  async batch(statements) {
    database.exec("BEGIN");
    try {
      const result=[];
      for (const statement of statements) result.push(await statement.run());
      database.exec("COMMIT");
      return result;
    } catch(error) {database.exec("ROLLBACK");throw error;}
  },
};
const ai={run:(model,options)=>new Promise((resolve,reject)=>{
  const body=JSON.stringify({model,options});
  const req=request("http://127.0.0.1:8798/?inference=1",{
    method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)},
  },response=>{
    let data="";
    response.on("data",chunk=>{data+=chunk;});
    response.on("end",()=>{
      try {
        if (response.statusCode!==200) throw new Error("Inference bridge failed");
        resolve(JSON.parse(data));
      } catch(error) {reject(error);}
    });
  });
  req.on("error",reject);
  req.setTimeout(25000,()=>req.destroy(new Error("Inference bridge timed out")));
  req.end(body);
})};
if (!process.env.BOT_TEST_TMDB_TOKEN) throw new Error("Missing test TMDB token");
const env={BOT_DB:db,AI:ai,TMDB_READ_TOKEN:process.env.BOT_TEST_TMDB_TOKEN};
const flows=process.argv.slice(2);
let failures=0;
for (const flow of flows.length ? flows : ["guided","bounds","director","partial"]) {
  try {
    const result=await flowEval(flow,env);
    console.log(JSON.stringify(result));
    if (!result.pass) failures++;
  } catch(error) {console.log(JSON.stringify({flow,pass:false,error:error.message}));failures++;}
}
process.exitCode=failures ? 1 : 0;
