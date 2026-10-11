/* BookNest — light / dark theme toggle.
   The first paint is handled by a tiny script in index.html's <head>;
   this file only wires up the button and remembers the choice. */
(function(){
  var btn = document.getElementById('themeBtn');
  var KEY = 'booknest-theme';

  function current(){
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }
  function apply(theme, save){
    document.documentElement.setAttribute('data-theme', theme);
    if(save){ try{ localStorage.setItem(KEY, theme); }catch(e){} }
    if(btn){
      var label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
  }

  if(btn){
    btn.addEventListener('click', function(){
      apply(current() === 'dark' ? 'light' : 'dark', true);
    });
  }
  apply(current(), false);

  // until the person picks a theme themselves, follow the device setting
  if(window.matchMedia){
    var mq = window.matchMedia('(prefers-color-scheme: light)');
    var follow = function(e){
      var saved = null;
      try{ saved = localStorage.getItem(KEY); }catch(_){}
      if(!saved) apply(e.matches ? 'light' : 'dark', false);
    };
    if(mq.addEventListener) mq.addEventListener('change', follow);
  }
})();
