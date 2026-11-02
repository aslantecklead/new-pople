import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitNarration, sceneCaptions, planTimeline, planOrderedTimeline} from './timeline.js';

test('narration preserves every word, punctuation and original order',()=>{
  const text='В Госдуме предложили маркировать корм для животных. Депутат пояснила, что маркировка поможет отследить путь товара от завода до магазина, а опасную партию можно будет изъять.';
  const parts=splitNarration(text);
  assert.equal(parts.join(' '),text);
  assert.ok(parts.every(p=>p.split(' ').length<=12));
  assert.ok(parts.length>2);
});
test('captions use measured duration, configured style and a short animation',()=>{
  const ass=sceneCaptions('Корм для животных',4.75,{font:'DejaVu Serif',size:68,color:'&H0000D7FF'});
  assert.match(ass,/0:00:04.75/);
  assert.match(ass,/DejaVu Serif,68,&H0000D7FF/);
  assert.match(ass,/\\fad\(100,100\)/);
});
test('manual timeline preserves asset order without jumping back to the first shot',()=>{
  const assets=[{id:'a',object_key:'a.jpg',mime_type:'image/jpeg',original_name:'one',tags:[]},{id:'b',object_key:'b.mp4',mime_type:'video/mp4',original_name:'two',tags:[]}];
  const scenes=planOrderedTimeline('Первая короткая фраза. Вторая короткая фраза. Третья короткая фраза.',assets);
  assert.deepEqual(scenes.map(scene=>scene.assetId),['a','a','b']);
});
test('AI chooses assets without being able to rewrite narration',async()=>{
  const original=globalThis.fetch;
  const oldBase=process.env.OLLAMA_BASE_URL,oldModel=process.env.OLLAMA_MODEL;
  process.env.OLLAMA_BASE_URL='http://localhost';process.env.OLLAMA_MODEL='test';
  globalThis.fetch=async()=>new Response(JSON.stringify({response:JSON.stringify({assignments:[{phrase:0,asset:1},{phrase:1,asset:0}]})}));
  try {
    const assets=[{id:'a',object_key:'a.jpg',mime_type:'image/jpeg',original_name:'building',tags:[]},{id:'b',object_key:'b.mp4',mime_type:'video/mp4',original_name:'dog',tags:[]}];
    assert.deepEqual(await planTimeline('Собака ест корм. Депутаты обсуждают маркировку.',assets),[{text:'Собака ест корм.',assetId:'b'},{text:'Депутаты обсуждают маркировку.',assetId:'a'}]);
  } finally {globalThis.fetch=original; if(oldBase===undefined)delete process.env.OLLAMA_BASE_URL;else process.env.OLLAMA_BASE_URL=oldBase;if(oldModel===undefined)delete process.env.OLLAMA_MODEL;else process.env.OLLAMA_MODEL=oldModel;}
});
