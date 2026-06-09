// Auth guard — initialises Supabase and redirects unauthenticated visitors to index.html.
// Exposes window.cafDB and window.cafUser for use by other scripts on the same page.
(function () {
  const URL = 'https://vffdvrfppadopcwhzjug.supabase.co';
  const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmZmR2cmZwcGFkb3Bjd2h6anVnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg2NzM2NjYsImV4cCI6MjA5NDI0OTY2Nn0.kcq6L07PLnagMevFdh_kXskKD7PjjYMkiXMgEWdcFH8';

  const { createClient } = window.supabase;
  window.cafDB   = createClient(URL, KEY);
  window.cafUser = null;

  window.cafDB.auth.getSession().then(function (result) {
    var session = result.data && result.data.session;
    if (session && session.user) {
      window.cafUser = session.user;
      var app = document.getElementById('appContainer');
      if (app) app.classList.add('visible');
      window.dispatchEvent(new CustomEvent('caf-ready', { detail: session.user }));
    } else {
      window.location.replace('index.html');
      return;
    }

    window.cafDB.auth.onAuthStateChange(function (event, session) {
      if (event === 'SIGNED_OUT') {
        window.cafUser = null;
        window.location.replace('index.html');
      }
    });
  });
})();
