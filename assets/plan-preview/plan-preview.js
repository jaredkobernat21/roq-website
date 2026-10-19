/* ROQ plan preview + intake.
   One overlay, configured per service in PLANS below. Any button with
   data-plan-preview="dream" or "renovation" opens it; the button itself is
   left exactly as the page styles it.

   Flow: preview (sample publication + what's included + price)
         -> Start My Plan -> 1 Project -> 2 Details -> 3 Review -> submitted.

   There is no Stripe checkout for these plans yet (the only checkout on the
   site is the $10 Property Fingerprint), so the review step sends a real
   request through project-potential-intake, the same endpoint every intake
   form on the site uses, and shows a confirmation only once it succeeds.
   When checkout exists, swap submitRequest() for a call that returns the
   Stripe URL and redirect to it. */

(function () {
  'use strict';

  var SUPABASE_URL = 'https://pgcospvlhorcvssafjoo.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_E8B6OF7rTmNhlEVvS36fiA_wewl5tER';
  var FUNCTION_URL = SUPABASE_URL + '/functions/v1/project-potential-intake';
  var ASSETS = '/assets/plan-preview/';

  var DISCLAIMER =
    'ROQ Home provides home planning and conceptual design guidance, not licensed architecture or ' +
    'engineering services. Floor plans are conceptual, feasibility reviews are preliminary, and cost ' +
    'guidance is estimated. Professional evaluation and approvals are required before construction.';

  /* ---------- Sample publication pages ----------
     Illustrative layouts only: no dimensions, no dollar figures. They show
     the shape of the deliverable, not results for anyone's real project. */

  function head(series, n) {
    return '<div class="pp-page-head"><span>ROQ &middot; ' + series + '</span><span>' + n + '</span></div>';
  }

  function foot(left) {
    return '<div class="pp-page-foot"><span>' + left + '</span><span>Sample edition</span></div>';
  }

  function cover(o) {
    return (
      '<div class="pp-page pp-cover">' +
        '<img src="' + ASSETS + o.img + '" alt="" loading="lazy" decoding="async" />' +
        '<div class="pp-cover-shade"' + (o.shade ? ' style="background:rgba(12,11,9,' + o.shade + ')"' : '') + '></div>' +
        '<div class="pp-page-inner">' +
          '<div class="pp-masthead"><b>ROQ</b><span>Home Plans<br />' + o.issue + '</span></div>' +
          '<div class="pp-cover-rule"></div>' +
          '<div class="pp-cover-series">' + o.series + '</div>' +
          '<div class="pp-cover-bottom">' +
            '<h3>' + o.title + '</h3>' +
            '<p>' + o.sub + '</p>' +
            '<div class="pp-cover-meta"><span>Prepared for the homeowner</span><span>Sample edition</span></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function page(series, n, body) {
    return '<div class="pp-page"><div class="pp-page-inner">' + head(series, n) + body + '</div></div>';
  }

  // A full-bleed photo page: running head at the top, chapter title at the foot.
  function photoPage(o) {
    return (
      '<div class="pp-page pp-cover pp-photo">' +
        '<img src="' + ASSETS + o.img + '" alt="" loading="lazy" decoding="async" />' +
        '<div class="pp-cover-shade"' + (o.shade ? ' style="background:rgba(12,11,9,' + o.shade + ')"' : '') + '></div>' +
        '<div class="pp-page-inner">' +
          head(o.series, o.n) +
          '<div class="pp-cover-bottom">' +
            '<div class="pp-photo-kicker">' + o.kicker + '</div>' +
            '<h3>' + o.title + '</h3>' +
            '<p>' + o.copy + '</p>' +
            '<div class="pp-cover-meta"><span>' + o.foot + '</span><span>Sample edition</span></div>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  var PLANS = {
    dream: {
      key: 'dream',
      name: 'Dream Home Plan',
      price: '$499',
      eyebrow: 'Dream Home Plan',
      title: 'Your dream home starts here.',
      lede: 'Turn your vision into a personalized home concept with a custom floor plan, architectural design direction, and a clear path toward building.',
      included: [
        'Preliminary site considerations',
        'Custom conceptual floor plan',
        'Architectural style &amp; design direction',
        'Preliminary build budget guidance',
        'Professional handoff roadmap'
      ],
      pages: [
        {
          label: 'Cover',
          alt: 'Sample cover: The Ridgeline Residence, a white modern farmhouse with dark gables',
          html: cover({
            img: 'dream-cover.jpg',
            issue: 'No. 01',
            series: 'Dream Home Plan',
            shade: 0.3,
            title: 'The Ridgeline Residence',
            sub: 'A personal home concept shaped around the land, the light, and the way the family lives.'
          })
        },
        {
          label: 'Site feasibility',
          alt: 'Sample page: site feasibility, over an aerial view of an open lot',
          html: photoPage({
            img: 'dream-site.jpg', series: 'Dream Home Plan', n: '03', shade: 0.34,
            kicker: 'Chapter I &middot; The land',
            title: 'Site feasibility',
            copy: 'A preliminary read of the lot: access, orientation, slope, setbacks, and utilities, before anything is drawn.',
            foot: 'Preliminary review'
          })
        },
        {
          label: 'Floor plan',
          alt: 'Sample page: a conceptual floor plan, over a photo of a homeowner and designer reviewing plans',
          html: photoPage({
            img: 'dream-floorplan.jpg', series: 'Dream Home Plan', n: '07', shade: 0.42,
            kicker: 'Chapter II &middot; The plan',
            title: 'A conceptual floor plan',
            copy: 'Rooms arranged around how you live, organized for your lot, your priorities, and your budget.',
            foot: 'Conceptual &middot; not for construction'
          })
        },
        {
          label: 'Design direction',
          alt: 'Sample page: design direction, over a tray of material and finish samples',
          html: photoPage({
            img: 'dream-design.jpg', series: 'Dream Home Plan', n: '11', shade: 0.4,
            kicker: 'Chapter III &middot; Character',
            title: 'Design direction',
            copy: 'Architectural style, materials, and finishes brought together into one clear point of view.',
            foot: 'Style &amp; materials'
          })
        },
        {
          label: 'Professional handoff',
          alt: 'Sample page: professional handoff, over hands marking up drawings and sketches',
          html: photoPage({
            img: 'dream-handoff.jpg', series: 'Dream Home Plan', n: '15', shade: 0.44,
            kicker: 'Chapter IV &middot; Next steps',
            title: 'Professional handoff',
            copy: 'An organized package and roadmap to take to your architect, engineer, and builder.',
            foot: 'Roadmap to build'
          })
        }
      ],
      projectQuestion: 'What are you planning?',
      projects: ['New custom home', 'Vacation or second home', 'Exploring future possibilities'],
      budgets: ['Under $400,000', '$400,000–$750,000', '$750,000–$1 million', 'Over $1 million', 'Not sure yet'],
      locationHint: 'City, region, or lot address',
      visionHint: 'The setting, the feeling, the rooms that matter most…'
    },

    renovation: {
      key: 'renovation',
      name: 'Renovation Plan',
      price: '$199',
      eyebrow: 'Renovation Plan',
      title: 'Make more of the home you have.',
      lede: 'Discover your home’s potential with thoughtful renovation priorities, budget guidance, and a personalized roadmap for your next project.',
      included: [
        'Home &amp; neighborhood value assessment',
        'Renovation priorities &amp; potential ROI scenarios',
        'Preliminary project budget',
        'DIY vs. contractor guidance',
        'Personalized renovation roadmap'
      ],
      pages: [
        {
          label: 'Cover',
          alt: 'Sample cover: The Fieldstone Kitchen, a renovated kitchen with oak beams and stone',
          html: cover({
            img: 'renovation-cover.jpg',
            issue: 'No. 02',
            series: 'Renovation Plan',
            shade: 0.34,
            title: 'The Fieldstone Kitchen',
            sub: 'A considered plan for a warmer, brighter heart of the home, prioritized for value and everyday life.'
          })
        },
        {
          label: 'Value',
          alt: 'Sample page: where the home sits against its neighborhood ceiling range',
          html: page('Renovation Plan', '03',
            '<div class="pp-page-kicker">Chapter I &middot; Your home today</div>' +
            '<div class="pp-page-title">Home &amp; neighborhood value</div>' +
            '<div class="pp-page-copy">Where your home sits today, what the neighborhood supports, and how much room there is to improve before a project stops paying back.</div>' +
            '<div class="pp-scale">' +
              '<div class="pp-scale-line"></div><div class="pp-scale-band"></div><div class="pp-scale-dot"></div>' +
              '<div class="pp-scale-label pp-scale-label--home">Your home<br />today</div>' +
              '<div class="pp-scale-label pp-scale-label--grow">Room to<br />grow</div>' +
              '<div class="pp-scale-label pp-scale-label--ceiling">Neighborhood<br />ceiling range</div>' +
            '</div>' +
            '<div class="pp-plan-notes">' +
              '<div><b>Today</b>Your home against recent comparable sales.</div>' +
              '<div><b>Ceiling</b>What buyers in your area are paying at the top.</div>' +
              '<div><b>Headroom</b>How much improvement the market supports.</div>' +
            '</div>' +
            foot('Value assessment'))
        },
        {
          label: 'Priorities',
          alt: 'Sample page: renovation priorities with potential return scenarios',
          html: page('Renovation Plan', '07',
            '<div class="pp-page-kicker">Chapter II &middot; Priorities</div>' +
            '<div class="pp-page-title">Where to begin</div>' +
            '<div class="pp-figure-pair">' +
              '<img src="' + ASSETS + 'renovation-livingroom.jpg" alt="" loading="lazy" decoding="async" />' +
              '<img src="' + ASSETS + 'renovation-bathroom.jpg" alt="" loading="lazy" decoding="async" />' +
            '</div>' +
            '<div style="margin-top:4cqw">' +
              '<div class="pp-priority"><b>01</b><span>Kitchen refresh</span><em>ROI scenario</em></div>' +
              '<div class="pp-priority"><b>02</b><span>Primary bath</span><em>ROI scenario</em></div>' +
              '<div class="pp-priority"><b>03</b><span>Living room &amp; lighting</span><em>Lifestyle</em></div>' +
            '</div>' +
            foot('Priorities &amp; potential ROI'))
        },
        {
          label: 'Budget &amp; roadmap',
          alt: 'Sample page: project budget, DIY versus contractor guidance and a roadmap',
          html: page('Renovation Plan', '12',
            '<div class="pp-page-kicker">Chapter III &middot; The plan</div>' +
            '<div class="pp-page-title">Budget, hands &amp; roadmap</div>' +
            '<div class="pp-cols" style="grid-template-columns:1fr">' +
              '<div><div class="pp-col-title">Preliminary project budget</div><ul class="pp-lines">' +
                '<li>Materials &amp; finishes<em>Estimated range</em></li>' +
                '<li>Labor &amp; trades<em>Estimated range</em></li>' +
                '<li>Permits &amp; contingency<em>Estimated range</em></li>' +
              '</ul></div>' +
            '</div>' +
            '<div class="pp-cols">' +
              '<div><div class="pp-col-title">DIY</div><ul class="pp-lines">' +
                '<li>Paint &amp; finishes</li><li>Hardware</li><li>Light fixtures</li></ul></div>' +
              '<div><div class="pp-col-title">Contractor</div><ul class="pp-lines">' +
                '<li>Electrical</li><li>Plumbing</li><li>Cabinet install</li></ul></div>' +
            '</div>' +
            '<div class="pp-roadmap">' +
              '<div><b>01</b>Plan</div><div><b>02</b>Price</div><div><b>03</b>Build</div><div><b>04</b>Enjoy</div>' +
            '</div>' +
            foot('Preliminary budget &amp; roadmap'))
        }
      ],
      projectQuestion: 'What are you planning?',
      projects: ['Kitchen or bathroom renovation', 'Addition or major renovation', 'Multiple home improvements', 'Not sure yet'],
      budgets: ['Under $20,000', '$20,000–$75,000', '$75,000–$200,000', 'Over $200,000', 'Not sure yet'],
      locationHint: 'Home address or city',
      visionHint: 'What you’d like to change, and what’s not working today…'
    }
  };

  /* ---------- Overlay ---------- */

  var root, panel, stage, book, thumbs, side, views = {};
  var plan = null, trigger = null, pageIndex = 0;
  var data = {};       // per-plan answers, kept while the page is open
  var submitted = {};  // per-plan: true once a request went through

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function build() {
    root = el('div', 'pp');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="pp-panel" role="dialog" aria-modal="true" aria-labelledby="ppTitle">' +
        '<button type="button" class="pp-close" aria-label="Close">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" /></svg>' +
        '</button>' +
        '<div class="pp-stage">' +
          '<figure class="pp-book" aria-live="polite"></figure>' +
          '<ul class="pp-thumbs" aria-label="Sample pages"></ul>' +
          '<p class="pp-sample-note">Sample publication shown for illustration. Your plan is prepared for your home.</p>' +
        '</div>' +
        '<div class="pp-side">' +
          '<section class="pp-view" data-view="preview"></section>' +
          '<section class="pp-view" data-view="project"></section>' +
          '<section class="pp-view" data-view="details"></section>' +
          '<section class="pp-view" data-view="review"></section>' +
          '<section class="pp-view pp-done" data-view="done"></section>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    panel = root.querySelector('.pp-panel');
    stage = root.querySelector('.pp-stage');
    book = root.querySelector('.pp-book');
    thumbs = root.querySelector('.pp-thumbs');
    side = root.querySelector('.pp-side');
    root.querySelectorAll('.pp-view').forEach(function (v) { views[v.dataset.view] = v; });

    root.querySelector('.pp-close').addEventListener('click', close);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    root.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog.
    var f = Array.prototype.filter.call(
      panel.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'),
      function (n) { return !n.disabled && n.offsetParent !== null; }
    );
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open(key, from) {
    if (!PLANS[key]) return;
    if (!root) build();
    trigger = from || null;

    if (!plan || plan.key !== key) {
      plan = PLANS[key];
      renderPublication();
      renderPreview();
    }
    if (!data[key]) data[key] = {};

    // A finished request starts fresh next time; otherwise reopen where they left off.
    if (submitted[key]) { submitted[key] = false; data[key] = {}; show('preview'); }
    else if (!root.dataset.state || root.dataset.plan !== key) show('preview');
    root.dataset.plan = key;

    document.documentElement.classList.add('pp-locked');
    root.setAttribute('aria-hidden', 'false');
    // Next frame so the opening transition runs.
    requestAnimationFrame(function () {
      root.classList.add('is-open');
      focusView();
    });
  }

  function close() {
    if (!root || !root.classList.contains('is-open')) return;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('pp-locked');
    if (trigger) trigger.focus();
  }

  /* ---------- Publication ---------- */

  function renderPublication() {
    book.innerHTML = '';
    thumbs.innerHTML = '';
    plan.pages.forEach(function (p, i) {
      var big = el('div', null, p.html).firstChild;
      big.setAttribute('aria-hidden', 'true');
      book.appendChild(big);

      var li = el('li');
      var btn = el('button', 'pp-thumb');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Show sample page: ' + p.label.replace('&amp;', 'and'));
      var mini = el('span', 'pp-thumb-page', p.html);
      mini.setAttribute('aria-hidden', 'true');
      btn.appendChild(mini);
      btn.appendChild(el('span', 'pp-thumb-label', p.label));
      btn.addEventListener('click', function () { showPage(i); });
      li.appendChild(btn);
      thumbs.appendChild(li);
    });
    showPage(0);
  }

  function showPage(i) {
    pageIndex = i;
    Array.prototype.forEach.call(book.children, function (n, j) { n.classList.toggle('is-active', j === i); });
    Array.prototype.forEach.call(thumbs.querySelectorAll('.pp-thumb'), function (b, j) {
      b.setAttribute('aria-current', j === i ? 'true' : 'false');
    });
    book.setAttribute('aria-label', plan.pages[i].alt);
  }

  /* ---------- Views ---------- */

  function show(name) {
    root.dataset.state = name;
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('is-active', k === name); });
    root.classList.toggle('is-intake', name !== 'preview');
    if (name === 'project') renderProject();
    if (name === 'details') renderDetails();
    if (name === 'review') renderReview();
    side.scrollTop = 0;
    panel.scrollTop = 0;
    if (root.classList.contains('is-open')) focusView();
  }

  function focusView() {
    var v = views[root.dataset.state];
    var h = v && v.querySelector('h2');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }

  function steps(current) {
    var names = ['Project', 'Details', 'Review'];
    return '<ol class="pp-steps" aria-label="Progress">' + names.map(function (n, i) {
      var cls = i < current ? ' class="is-done"' : '';
      var cur = i === current ? ' aria-current="step"' : '';
      return '<li' + cls + cur + '>' + (i + 1) + ' &middot; ' + n + '</li>';
    }).join('') + '</ol>';
  }

  function renderPreview() {
    var v = views.preview;
    v.innerHTML =
      '<p class="pp-eyebrow">' + plan.eyebrow + '</p>' +
      '<h2 class="pp-title" id="ppTitle">' + plan.title + '</h2>' +
      '<p class="pp-lede">' + plan.lede + '</p>' +
      '<hr class="pp-rule" />' +
      '<h3 class="pp-included-title">What&rsquo;s included</h3>' +
      '<ul class="pp-included">' + plan.included.map(function (t, i) {
        return '<li><span>0' + (i + 1) + '</span>' + t + '</li>';
      }).join('') + '</ul>' +
      '<div class="pp-buy">' +
        '<div><span class="pp-price-label">Starting at</span><span class="pp-price">' + plan.price + '</span></div>' +
        '<button type="button" class="pp-btn" data-go="project">Start My Plan</button>' +
      '</div>' +
      '<p class="pp-fine">' + DISCLAIMER + '</p>';
    v.querySelector('[data-go]').addEventListener('click', function () { show('project'); });
  }

  function radios(name, legend, options, value) {
    return '<fieldset class="pp-fieldset"><legend class="pp-legend">' + legend + '</legend><div class="pp-choices">' +
      options.map(function (o) {
        return '<label class="pp-choice"><input type="radio" name="' + name + '" value="' + esc(o) + '"' +
          (o === value ? ' checked' : '') + ' />' + esc(o) + '</label>';
      }).join('') + '</div></fieldset>';
  }

  function renderProject() {
    var d = data[plan.key];
    var v = views.project;
    v.innerHTML =
      steps(0) +
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">Tell us about your project.</h2>' +
      '<form novalidate>' +
        radios('pp-project', plan.projectQuestion, plan.projects, d.project) +
        radios('pp-budget', 'Estimated project budget', plan.budgets, d.budget) +
        '<p class="pp-error" role="alert"></p>' +
        '<div class="pp-actions">' +
          '<button type="button" class="pp-btn pp-btn--quiet" data-back>Back</button>' +
          '<button type="submit" class="pp-btn">Continue</button>' +
        '</div>' +
      '</form>';

    var form = v.querySelector('form');
    form.addEventListener('change', function () {
      var p = form.querySelector('[name="pp-project"]:checked');
      var b = form.querySelector('[name="pp-budget"]:checked');
      d.project = p ? p.value : d.project;
      d.budget = b ? b.value : d.budget;
    });
    v.querySelector('[data-back]').addEventListener('click', function () { show('preview'); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = form.querySelector('.pp-error');
      if (!d.project) return fail(err, 'Please choose what you are planning.', form.querySelector('[name="pp-project"]'));
      if (!d.budget) return fail(err, 'Please choose an estimated budget.', form.querySelector('[name="pp-budget"]'));
      show('details');
    });
  }

  function field(id, label, type, value, opts) {
    opts = opts || {};
    var optional = opts.optional ? ' <small>(optional)</small>' : '';
    var attrs = ' id="' + id + '" name="' + id + '" maxlength="' + (opts.max || 200) + '"' +
      (opts.auto ? ' autocomplete="' + opts.auto + '"' : '') +
      (opts.hint ? ' placeholder="' + esc(opts.hint) + '"' : '') +
      (opts.optional ? '' : ' required');
    var input = type === 'textarea'
      ? '<textarea class="pp-input"' + attrs + '>' + esc(value || '') + '</textarea>'
      : '<input class="pp-input" type="' + type + '"' + attrs + ' value="' + esc(value || '') + '" />';
    return '<div class="pp-field"><label class="pp-label" for="' + id + '">' + label + optional + '</label>' + input + '</div>';
  }

  function renderDetails() {
    var d = data[plan.key];
    var v = views.details;
    v.innerHTML =
      steps(1) +
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">Your details</h2>' +
      '<form novalidate>' +
        field('pp-name', 'Full name', 'text', d.name, { auto: 'name', max: 120 }) +
        field('pp-email', 'Email', 'email', d.email, { auto: 'email', hint: 'you@example.com' }) +
        field('pp-phone', 'Phone', 'tel', d.phone, { auto: 'tel', optional: true, max: 40 }) +
        field('pp-location', 'Property location', 'text', d.location, { auto: 'street-address', optional: true, hint: plan.locationHint, max: 300 }) +
        field('pp-vision', 'Your project or vision, in a few words', 'textarea', d.vision, { hint: plan.visionHint, max: 1000 }) +
        '<p class="pp-error" role="alert"></p>' +
        '<div class="pp-actions">' +
          '<button type="button" class="pp-btn pp-btn--quiet" data-back>Back</button>' +
          '<button type="submit" class="pp-btn">Review</button>' +
        '</div>' +
      '</form>';

    var form = v.querySelector('form');
    function read() {
      d.name = form['pp-name'].value.trim();
      d.email = form['pp-email'].value.trim();
      d.phone = form['pp-phone'].value.trim();
      d.location = form['pp-location'].value.trim();
      d.vision = form['pp-vision'].value.trim();
    }
    form.addEventListener('input', function (e) {
      read();
      e.target.removeAttribute('aria-invalid');
    });
    v.querySelector('[data-back]').addEventListener('click', function () { read(); show('project'); });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      read();
      var err = form.querySelector('.pp-error');
      if (!d.name) return fail(err, 'Please enter your full name.', form['pp-name']);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return fail(err, 'Please enter a valid email address.', form['pp-email']);
      if (d.phone && d.phone.replace(/\D/g, '').length < 10) return fail(err, 'Please enter a valid phone number, or leave it blank.', form['pp-phone']);
      if (!d.vision) return fail(err, 'Please tell us a little about your project.', form['pp-vision']);
      show('review');
    });
  }

  function renderReview() {
    var d = data[plan.key];
    var v = views.review;
    function row(k, val) { return '<dt>' + k + '</dt><dd>' + esc(val || '—') + '</dd>'; }
    v.innerHTML =
      steps(2) +
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">Review your request</h2>' +
      '<div class="pp-review">' +
        '<div class="pp-review-group"><div class="pp-review-head"><h4>Service</h4></div><dl>' +
          row('Plan', plan.name) + row('Price', 'Starting at ' + plan.price) + '</dl></div>' +
        '<div class="pp-review-group"><div class="pp-review-head"><h4>Project</h4>' +
          '<button type="button" class="pp-edit" data-edit="project" aria-label="Edit project">Edit</button></div><dl>' +
          row('Project', d.project) + row('Budget', d.budget) + '</dl></div>' +
        '<div class="pp-review-group"><div class="pp-review-head"><h4>Details</h4>' +
          '<button type="button" class="pp-edit" data-edit="details" aria-label="Edit details">Edit</button></div><dl>' +
          row('Name', d.name) + row('Email', d.email) + row('Phone', d.phone) +
          row('Location', d.location) + row('Vision', d.vision) + '</dl></div>' +
      '</div>' +
      '<p class="pp-submit-note">No payment is due today. We&rsquo;ll review your project and follow up by email with next steps.</p>' +
      '<p class="pp-error" role="alert"></p>' +
      '<div class="pp-actions">' +
        '<button type="button" class="pp-btn pp-btn--quiet" data-back>Back</button>' +
        '<button type="button" class="pp-btn" data-submit>Submit Request</button>' +
      '</div>';

    v.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.edit); });
    });
    v.querySelector('[data-back]').addEventListener('click', function () { show('details'); });
    var btn = v.querySelector('[data-submit]');
    btn.addEventListener('click', function () {
      var err = v.querySelector('.pp-error');
      err.classList.remove('is-visible');
      btn.disabled = true;
      btn.textContent = 'Sending…';
      submitRequest(plan, d).then(function () {
        submitted[plan.key] = true;
        renderDone(d);
        show('done');
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = 'Submit Request';
        fail(err, e.message || 'Could not send your request. Please try again.');
      });
    });
  }

  function renderDone(d) {
    var first = (d.name || '').split(/\s+/)[0];
    views.done.innerHTML =
      '<p class="pp-eyebrow">' + plan.name + '</p>' +
      '<h2 class="pp-title" id="ppTitle">Thank you' + (first ? ', ' + esc(first) : '') + '.</h2>' +
      '<p class="pp-lede">Your request is in. We&rsquo;ll review your project and follow up at <strong>' +
        esc(d.email) + '</strong> with next steps.</p>' +
      '<button type="button" class="pp-btn" data-close>Close</button>';
    views.done.querySelector('[data-close]').addEventListener('click', close);
  }

  function fail(errEl, msg, focusEl) {
    errEl.textContent = msg;
    errEl.classList.add('is-visible');
    if (focusEl) {
      if (focusEl.setAttribute) focusEl.setAttribute('aria-invalid', 'true');
      focusEl.focus();
    }
  }

  /* ---------- Submission ----------
     project-potential-intake takes { address, project_type, contact }. The
     address must be 8+ characters, so a short or missing location is padded
     with a plain-language note rather than rejected. Everything else rides in
     project_type, which is the line the notification email leads with. */

  function submitRequest(p, d) {
    var loc = d.location || '';
    var address = !loc ? 'Not provided' : (loc.length >= 8 ? loc : loc + ' (as entered)');
    var summary = [
      p.name + ' (' + p.price + ')',
      d.project,
      'Budget: ' + d.budget,
      'Name: ' + d.name,
      'Phone: ' + (d.phone || '—'),
      'Location: ' + (loc || '—'),
      'Vision: ' + d.vision
    ].join(' | ');

    return fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ address: address, project_type: summary, contact: d.email, contact_method: 'email' })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.error || 'Could not send your request. Please try again.');
      });
    }, function () {
      throw new Error('We couldn’t reach our server. Check your connection and try again.');
    });
  }

  /* ---------- Wire up the existing Learn more buttons ---------- */

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-plan-preview]');
    if (!b) return;
    e.preventDefault();
    open(b.getAttribute('data-plan-preview'), b);
  });

  window.ROQPlanPreview = { open: open, close: close };
})();
