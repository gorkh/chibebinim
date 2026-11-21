import { interpret, normalizeInput } from "../bot/language.mjs";
import { cases } from "../bot/language-cases.mjs";
import { flowEval } from "./flow-eval.mjs";

export default {
  async fetch(request, env) {
    const params=new URL(request.url).searchParams;
    if (params.has("inference") && request.method==="POST") {
      const body=await request.json();
      return Response.json(await env.AI.run(body.model,body.options));
    }
    if (params.has("flow") && request.method==="POST") {
      try { return Response.json(await flowEval(params.get("flow"),env)); }
      catch(error) { return Response.json({pass:false,error:error.message}); }
    }
    const index=Number(params.get("case"));
    if (request.method !== "POST" || !params.has("case") || !cases[index]) return new Response(null,{status:404});
    const [input,expected]=cases[index];
    const result=await interpret(env.AI,input);
    const actual={...(result.query ?? result.parsed_filters)};
    delete actual.search_hints;
    if (actual.similar_to) actual.similar_to=actual.similar_to[0];
    if (result.unsupported?.length) actual.unsupported=result.unsupported;
    if (result.status==="unrelated") actual.unrelated=true;
    if (["ambiguous","incomplete_coverage"].includes(result.status)) actual.clarify=true;
    const norm=value=>Array.isArray(value) ? value.map(norm).sort() : typeof value==="string" ? normalizeInput(value) : value;
    const allowed=new Set(Object.keys(expected));
    if (expected.director_name || expected.director_of) allowed.add("media_type");
    const pass=Object.entries(expected).every(([field,value])=>JSON.stringify(norm(actual[field]))===JSON.stringify(norm(value))) &&
      Object.keys(actual).every(field=>allowed.has(field));
    return Response.json({index,input,expected,actual,status:result.status,pass,
      elapsed_ms:result.elapsed_ms,neurons:result.neurons,message:result.message});
  },
};
