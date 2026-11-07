-- 一条迁移数据的人工修正（owner 裁决 B）。
--
-- 老系统里这条需求的「平台」是一整串自由文本：
--   「Web / PC / App / H5商品中心 / 分享页」
-- 里面混了两个层次：端（Web/PC/App）与页面（H5商品中心/分享页）。多值字段只接受 12 个
-- 固定的端，所以迁移时整条丢弃（`platforms = {}`）。
--
-- 按裁决：能对上的三个端落进 `platforms`，对不上的两个页面用文字留在 `context` 里——
-- 端是准的，页面信息没丢，只是换了地方。不用去问当初提需求的人。
--
-- 用 legacy_ref 定位而不是 number：number 是本库自己的序列，换一台库就不一样了。
update requirements
   set platforms = array['web', 'pc', 'mobile']::text[],
       context = '原记录的平台写作「Web / PC / App / H5商品中心 / 分享页」。'
              || E'\n' || '其中 Web / PC / App 已记为平台；「H5商品中心」「分享页」是页面而不是端，'
              || '多值平台字段表示不了，留在这里备查。'
 where legacy_ref = '123bd3a8-7d55-591f-a287-a9869ccd9628';
