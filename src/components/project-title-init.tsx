import { PRODUCT_NAME } from '@/lib/identity';

/**
 * Restore a known project title in the document head, before React or the
 * project request starts. This is deliberately tiny and synchronous: browser
 * tab lists should not expose the generic static-export title during reload.
 */
export function ProjectTitleInitScript() {
  const product = JSON.stringify(PRODUCT_NAME);
  return <script dangerouslySetInnerHTML={{ __html: `(function(){try{var u=new URL(location.href);if(u.pathname!='/project')return;var id=u.searchParams.get('id');var names=JSON.parse(localStorage.getItem('atelier.project-names')||'{}');var name=id&&names[id];if(name)document.title=name+' | '+${product}}catch(_){}})()` }} />;
}
