// SPDX-License-Identifier: BUSL-1.1
// Old homepage anchors keep working: the sections moved to their own pages.
const MOVED = {
  '#product': '/product#product', '#how': '/product#how', '#why': '/product#why', '#demos': '/product#demos',
  '#compare': '/compare', '#scope': '/compare#scope-section', '#integrate': '/docs#quickstart', '#limits': '/trust#limits',
};
if (MOVED[location.hash]) location.replace(MOVED[location.hash]);
