import assert from "node:assert/strict";
import {test} from "node:test";
import {sameSeries,findCandidates,rankItems} from "./catalog.mjs";

const media=(id,title,extra={})=>({id,title,original_title:title,genres:["fantasy"],themes:[],keywords:[],...extra});
test("Collections exclude sequels even when their titles are unrelated",()=>{
  assert.ok(sameSeries(media(2,"A Different Title",{collection_id:10}),media(1,"Original",{collection_id:10})));
  assert.equal(sameSeries(media(2,"Other",{collection_id:20}),media(1,"Original",{collection_id:10})),false);
});
test("Numbered films and TV subtitle continuations share a title family",()=>{
  for (const [a,b] of [["Toy Story","Toy Story 2"],["Rocky II","Rocky IV"],
    ["The Walking Dead","The Walking Dead: Dead City"],
    ["Dexter","Dexter: New Blood"],["Dark Matter: Chapter II","Dark Matter: Chapter III"],
    ["ارباب حلقه‌ها: یاران حلقه","ارباب حلقه ها: دو برج"]]) {
    assert.ok(sameSeries(media(1,a),media(2,b)),a+" / "+b);
    assert.ok(sameSeries(media(2,b),media(1,a)));
  }
});
test("Shared genres and generic title words do not define a series",()=>{
  assert.equal(sameSeries(media(1,"The Others"),media(2,"The Matrix")),false);
  assert.equal(sameSeries(media(1,"Love: First Story"),media(2,"Love: Another Story")),false);
  assert.equal(sameSeries(media(1,"Dark Shadows"),media(2,"Dark City")),false);
  assert.equal(sameSeries(media(1,"Other"),undefined),false);
});
test("Original titles and final ranking protect translated/cached recommendations",()=>{
  const reference=media(1,"عنوان فارسی",{original_title:"The Walking Dead"});
  const continuation=media(2,"عنوان متفاوت",{original_title:"The Walking Dead: Dead City"});
  const unrelated=media(3,"Another Fantasy");
  assert.deepEqual(rankItems({items:[continuation,unrelated],reference,related:[]},{},[],[],{}).map(x=>x.media.id),[3]);
});
test("Catalog filters collection siblings after hydration and TV siblings before hydration",async()=>{
  const originalFetch=globalThis.fetch;
  const db={prepare:()=>({bind:()=>({first:async()=>null,run:async()=>({})})})};
  try {
    for (const kind of ["movie","tv"]) {
      const row=(id,title)=>({id,[kind==="tv"?"name":"title"]:title,genre_ids:[14],release_date:"2001-01-01",first_air_date:"2001-01-01"});
      const root=row(900001,"Imaginary Kingdom");
      const sibling=row(900002,kind==="movie"?"An Unrelated Sequel Name":"Imaginary Kingdom: A New Story");
      const other=row(900003,"A Different Adventure");
      const hydrated=[];
      globalThis.fetch=async input=>{
        const path=new URL(input).pathname.replace("/3/","");
        let response;
        if (path.startsWith("search/")) response={results:path===`search/${kind}`?[root]:[]};
        else if (path.endsWith("/recommendations") || path===`discover/${kind}`) response={results:[sibling,other]};
        else if (path.startsWith(`${kind}/`)) {
          const id=Number(path.split("/")[1]);hydrated.push(id);
          response={...([root,sibling,other].find(item=>item.id===id)),genres:[{id:14}],
            belongs_to_collection:kind==="movie" && id!==other.id?{id:98765}:null};
        } else throw new Error("Unexpected request: "+path);
        return Response.json(response);
      };
      const result=await findCandidates(db,"mock",{similar_to:[root[kind==="tv"?"name":"title"]],media_type:kind});
      assert.deepEqual(result.items.map(item=>item.external_id),[String(other.id)]);
      if (kind==="tv") assert.ok(!hydrated.includes(sibling.id));
    }
  } finally {globalThis.fetch=originalFetch;}
});
