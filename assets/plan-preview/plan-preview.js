/* ROQ plan preview + intake.
   One overlay, configured per service in PLANS below. Any button with
   data-plan-preview="dream", "potential" or "renovation" opens it; the
   button itself is left exactly as the page styles it.

   Flow: preview (sample publication + what's included + price)
         -> Start My Plan -> the plan's own intake steps -> Review -> submitted.

   Plans marked `checkout` are paid through Stripe: the review step sends the
   answers to roq-plan-checkout, which saves a pending order and returns a
   Stripe Checkout URL; Stripe sends the customer back with ?checkout=success
   or ?checkout=cancelled, handled in resumeFromCheckout(). Every other plan
   sends a free request through project-potential-intake, the endpoint every
   intake form on the site uses.

   CHECKOUT_LIVE keeps payment off for visitors until it has been tested.
   Opening any page with ?pay=test turns it on for that browser tab. */

(function () {
  'use strict';

  var SUPABASE_URL = 'https://pgcospvlhorcvssafjoo.supabase.co';
  var SUPABASE_ANON_KEY = 'sb_publishable_E8B6OF7rTmNhlEVvS36fiA_wewl5tER';
  var FUNCTION_URL = SUPABASE_URL + '/functions/v1/project-potential-intake';
  var CHECKOUT_URL = SUPABASE_URL + '/functions/v1/roq-plan-checkout';
  var CHECKOUT_LIVE = false;
  var TERMS_URL = '/legal/roq-plan-terms.html';
  var ASSETS = '/assets/plan-preview/';

  var DISCLAIMER =
    'ROQ Home provides home planning and conceptual design guidance, not licensed architecture or ' +
    'engineering services. Floor plans are conceptual, feasibility reviews are preliminary, and cost ' +
    'guidance is estimated. Professional evaluation and approvals are required before construction.';

  /* ---------- Sample publication pages ----------
     Full-bleed photo pages carry chapter titles only. Each plan also has one
     report page set in type, showing what the deliverable actually reads
     like, with fictional figures that are labelled as such. */

  function head(series, n) {
    return '<div class="pp-page-head"><span>ROQ &middot; ' + series + '</span><span>' + n + '</span></div>';
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

  // A typeset report page: optional fact row, a table, and ROQ's recommendation.
  function reportPage(o) {
    var facts = o.facts ? '<dl class="pp-report-facts">' + o.facts.map(function (f) {
      return '<div><dt>' + f[0] + '</dt><dd>' + f[1] + '</dd></div>';
    }).join('') + '</dl>' : '';
    var cols = o.table.cols;
    function cells(row, tag) {
      return row.map(function (c, i) {
        var cls = cols[i].cls ? ' class="' + cols[i].cls + '"' : '';
        return '<' + tag + cls + '>' + c + '</' + tag + '>';
      }).join('');
    }
    return (
      '<div class="pp-page pp-report">' +
        '<div class="pp-page-inner">' +
          head(o.series, o.n) +
          '<div class="pp-report-kicker">' + o.kicker + '</div>' +
          '<h3 class="pp-report-title">' + o.title + '</h3>' +
          '<p class="pp-report-sub">' + o.sub + '</p>' +
          facts +
          '<table class="pp-report-table">' +
            '<thead><tr>' + cells(cols.map(function (c) { return c.label; }), 'th') + '</tr></thead>' +
            '<tbody>' + o.table.rows.map(function (r) { return '<tr>' + cells(r, 'td') + '</tr>'; }).join('') + '</tbody>' +
            (o.table.total ? '<tfoot><tr>' + cells(o.table.total, 'td') + '</tr></tfoot>' : '') +
          '</table>' +
          '<div class="pp-report-note"><span>ROQ recommendation</span><p>' + o.note + '</p></div>' +
          '<p class="pp-report-fine">' + o.fine + '</p>' +
        '</div>' +
      '</div>'
    );
  }

  /* ---------- Intake fields ----------
     Each plan lists its intake steps; each step lists its fields. Types:
     radio, checks (any number), text, email, tel, textarea. `short` is the
     label used in the review and in the request summary. One field per plan
     carries `address: true` and becomes the request's address. */

  var CONTACT = [
    { id: 'name', type: 'text', label: 'Full name', short: 'Name', auto: 'name', max: 120,
      error: 'Please enter your full name.' },
    { id: 'email', type: 'email', label: 'Email', short: 'Email', auto: 'email', hint: 'you@example.com',
      error: 'Please enter a valid email address.' },
    { id: 'phone', type: 'tel', label: 'Phone', short: 'Phone', auto: 'tel', optional: true, max: 40,
      error: 'Please enter a valid phone number, or leave it blank.' }
  ];

  var ADDRESS = {
    id: 'address', type: 'text', label: 'Property address', short: 'Address', address: true, min: 8,
    auto: 'street-address', hint: 'Street address, city, and state', max: 300,
    error: 'Please enter the property address.'
  };

  var BUDGETS_199 = ['Under $10,000', '$10,000–$25,000', '$25,000–$50,000', '$50,000–$100,000', 'Over $100,000', 'Not sure yet'];

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
      fine: DISCLAIMER,
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
      steps: [
        { name: 'Project', title: 'Tell us about your project.', fields: [
          { id: 'project', type: 'radio', label: 'What are you planning?', short: 'Project',
            options: ['New custom home', 'Vacation or second home', 'Exploring future possibilities'],
            error: 'Please choose what you are planning.' },
          { id: 'budget', type: 'radio', label: 'Estimated project budget', short: 'Budget',
            options: ['Under $400,000', '$400,000–$750,000', '$750,000–$1 million', 'Over $1 million', 'Not sure yet'],
            error: 'Please choose an estimated budget.' }
        ] },
        { name: 'Details', title: 'Your details', fields: CONTACT.concat([
          { id: 'location', type: 'text', label: 'Property location', short: 'Location', address: true, optional: true,
            auto: 'street-address', hint: 'City, region, or lot address', max: 300 },
          { id: 'vision', type: 'textarea', label: 'Your project or vision, in a few words', short: 'Vision', max: 1000,
            hint: 'The setting, the feeling, the rooms that matter most…',
            error: 'Please tell us a little about your project.' }
        ]) }
      ]
    },

    potential: {
      key: 'potential',
      name: 'Home Value Potential',
      price: '$199',
      priceLabel: 'One-time purchase',
      checkout: true,
      eyebrow: 'Home Value Potential',
      title: 'Know what&rsquo;s worth improving.',
      lede: 'Understand your home&rsquo;s market potential and discover which improvements may make financial sense. Get a personalized roadmap to invest thoughtfully and avoid over-renovating.',
      included: [
        { t: 'Home &amp; neighborhood value potential',
          d: 'Comparable homes, neighborhood market trends, and where your home sits within its local market.' },
        { t: 'Improvement opportunity analysis',
          d: 'Which improvements may be worthwhile and which may not justify their cost, given your home, goals, timeline, and neighborhood.' },
        { t: 'Renovation priorities',
          d: 'What deserves attention first, what to defer, and where you risk over-renovating.' },
        { t: 'Value improvement roadmap',
          d: 'A phased strategy with preliminary investment ranges, sequencing, and key decision points.' }
      ],
      excluded: [
        'Custom room designs or detailed floor plans',
        'Interior design or material selection packages',
        'Contractor matching or introductions',
        'Construction management',
        'Formal appraisals or certified valuations',
        'Guaranteed renovation ROI'
      ],
      cross: { text: 'Already know what you&rsquo;d like to renovate?', link: 'Explore the Renovation Plan', to: 'renovation' },
      fine: 'Home Value Potential is market research and home improvement guidance. ROQ Home is not a licensed real estate ' +
        'broker, agent, or appraiser, and this is not an appraisal, broker price opinion, or certified valuation. Market ' +
        'observations reflect publicly available information and are not a guarantee of value. Cost ranges are preliminary ' +
        'estimates, and no improvement is guaranteed to increase resale value.',
      pages: [
        {
          label: 'Cover',
          alt: 'Sample cover: The Linden Street Home, a modern home lit at dusk',
          html: cover({
            img: 'potential-cover.jpg',
            issue: 'No. 03',
            series: 'Home Value Potential',
            shade: 0.3,
            title: 'The Linden Street Home',
            sub: 'Understanding your home&rsquo;s potential and the improvements worth considering.'
          })
        },
        {
          label: 'Market',
          alt: 'Sample page: your home’s market potential, over an aerial view of a residential street',
          html: photoPage({
            img: 'renovation-value.jpg', series: 'Home Value Potential', n: '03', shade: 0.36,
            kicker: 'Chapter I &middot; Market',
            title: 'Your home&rsquo;s market potential',
            copy: 'Explore comparable homes, neighborhood market context, and the range of values supported by available market evidence.',
            foot: 'Market context'
          })
        },
        {
          label: 'Opportunities',
          alt: 'Sample page: improvement opportunities, over a couple painting a room',
          html: photoPage({
            img: 'renovation-priorities.jpg', series: 'Home Value Potential', n: '06', shade: 0.42,
            kicker: 'Chapter II &middot; Opportunities',
            title: 'What could make a difference',
            copy: 'Identify improvements that may enhance your home&rsquo;s everyday appeal and future marketability.',
            foot: 'Improvement opportunities'
          })
        },
        {
          label: 'Priorities',
          alt: 'Sample page: renovation priorities, over a white gable and a single dark window',
          html: photoPage({
            img: 'potential-priorities.jpg', series: 'Home Value Potential', n: '09', shade: 0.46,
            kicker: 'Chapter III &middot; Priorities',
            title: 'Invest with purpose',
            copy: 'Prioritize meaningful improvements while considering costs, local market expectations, and the risk of over-renovating.',
            foot: 'Renovation priorities'
          })
        },
        {
          label: 'Roadmap',
          alt: 'Sample report page: a ranked improvement list with preliminary budgets and an ROQ recommendation for a fictional home',
          html: reportPage({
            series: 'Home Value Potential', n: '12',
            kicker: 'Chapter IV &middot; Roadmap',
            title: 'Your path forward',
            sub: 'The Linden Street Home &middot; Illustrative example',
            facts: [
              ['Comparables', 'Nine nearby sales of similar size and age'],
              ['Neighborhood', 'Updated homes lead recent sales; few full remodels'],
              ['This home', 'Sound and well kept, with dated interior finishes']
            ],
            table: {
              cols: [{ label: 'No.', cls: 'pp-rank' }, { label: 'Improvement' }, { label: 'Preliminary budget', cls: 'pp-num' }],
              rows: [
                ['01', 'Kitchen refresh', '$8,000–$12,000'],
                ['02', 'Interior painting', '$3,000–$5,000'],
                ['03', 'Curb appeal improvements', '$2,000–$4,000'],
                ['04', 'Full bathroom renovation', '$12,000–$20,000']
              ]
            },
            note: 'Begin with targeted updates that improve the home&rsquo;s overall presentation before committing to larger structural or luxury improvements. Reevaluate higher-cost renovations against local comparable properties and the homeowner&rsquo;s intended ownership timeline.',
            fine: 'Fictional example. The home, figures, and recommendations are illustrative only. They are not an appraisal and do not predict any change in value.'
          })
        }
      ],
      steps: [
        { name: 'Home', title: 'Tell us about your home.', fields: [
          ADDRESS,
          { id: 'ptype', type: 'radio', label: 'Property type', short: 'Property type',
            options: ['Single-family home', 'Townhouse', 'Condo', 'Multi-family (2–4 units)', 'Other'],
            error: 'Please choose a property type.' },
          { id: 'size', type: 'text', label: 'Approximate size', short: 'Size', optional: true, max: 60,
            hint: 'e.g. 1,800 sq ft, 3 bed, 2 bath' },
          { id: 'built', type: 'text', label: 'Approximate year built', short: 'Year built', optional: true, max: 40,
            hint: 'e.g. 1985, or “not sure”' },
          { id: 'condition', type: 'radio', label: 'Overall condition', short: 'Condition',
            options: ['Updated and move-in ready', 'Good, but dated in places', 'Needs significant work', 'Not sure'],
            error: 'Please choose the overall condition.' },
          { id: 'completed', type: 'textarea', label: 'Major renovations already completed', short: 'Completed', optional: true, max: 600,
            hint: 'e.g. new roof in 2019, bathroom remodeled in 2015' }
        ] },
        { name: 'Goals', title: 'What are you hoping for?', fields: [
          { id: 'focus', type: 'checks', label: 'What matters most? <small>(choose any)</small>', short: 'Focus',
            options: ['Resale value', 'Long-term ownership', 'Everyday enjoyment'],
            error: 'Please choose at least one focus.' },
          { id: 'timeline', type: 'radio', label: 'How long do you expect to own the home?', short: 'Ownership timeline',
            options: ['Less than 2 years', '2–5 years', '5–10 years', '10+ years', 'Not sure yet'],
            error: 'Please choose an ownership timeline.' },
          { id: 'budget', type: 'radio', label: 'Approximate improvement budget', short: 'Budget',
            options: BUDGETS_199, error: 'Please choose an approximate budget.' },
          { id: 'considering', type: 'textarea', label: 'Improvements you&rsquo;re considering', short: 'Considering', optional: true, max: 800,
            hint: 'e.g. kitchen update, finishing the basement, new windows' },
          { id: 'goals', type: 'textarea', label: 'Anything else about your goals', short: 'Other goals', optional: true, max: 800,
            hint: 'What you’d like to get out of the home in the next few years…' }
        ] },
        { name: 'Details', title: 'Your details', fields: CONTACT }
      ]
    },

    renovation: {
      key: 'renovation',
      name: 'Renovation Plan',
      price: '$199',
      priceLabel: 'One-time purchase',
      eyebrow: 'Renovation Plan',
      title: 'Make your next project a better one.',
      lede: 'From design direction and preliminary budgeting to contractor selection and project sequencing, get a personalized plan for one specific renovation.',
      included: [
        { t: 'Project concept &amp; design direction',
          d: 'One cohesive direction for your room: style, materials and finishes, layout considerations, and practical recommendations.' },
        { t: 'Preliminary project budget',
          d: 'Estimated cost ranges for materials, labor, and major cost drivers, with contingency and ways to save. Not a contractor quote.' },
        { t: 'Contractor selection &amp; DIY guidance',
          d: 'Which work needs professionals and what may suit DIY, a hiring checklist, questions to ask, and research on up to three local candidates.' },
        { t: 'Project roadmap',
          d: 'Design decisions, budget confirmation, consultations, permits, estimates, purchasing, and sequencing, in order.' }
      ],
      excluded: [
        'Neighborhood value or property valuation research',
        'Whole-home improvement prioritization',
        'Guaranteed renovation ROI',
        'Construction-ready drawings, engineering, or architectural services',
        'Contractor hiring or project management',
        'Unlimited revisions or more than one project'
      ],
      cross: { text: 'Not sure which improvements are worth making?', link: 'Explore Home Value Potential', to: 'potential' },
      fine: 'The Renovation Plan covers one defined renovation and one primary design direction. ROQ Home provides conceptual ' +
        'design and planning guidance, not licensed architecture, engineering, or contracting services. Budgets are preliminary ' +
        'estimates, not contractor quotes. Contractor research uses publicly available information and is not an endorsement or a ' +
        'guarantee of availability, pricing, or workmanship. Permits and professional review may be required.',
      pages: [
        {
          label: 'Cover',
          alt: 'Sample cover: The Linden Street Kitchen, a bright kitchen with open shelving and a wood island',
          html: cover({
            img: 'renovation-cover.jpg',
            issue: 'No. 02',
            series: 'Renovation Plan',
            shade: 0.34,
            title: 'The Linden Street Kitchen',
            sub: 'A considered plan for a warmer, brighter kitchen, designed around everyday life, practical investment, and a clear path to renovation.'
          })
        },
        {
          label: 'Design',
          alt: 'Sample page: the design direction, over a homeowner and designer reviewing a layout',
          html: photoPage({
            img: 'renovation-design.jpg', series: 'Renovation Plan', n: '03', shade: 0.42,
            kicker: 'Chapter I &middot; Design',
            title: 'The design direction',
            copy: 'A cohesive vision for layout, materials, finishes, and the experience of the space.',
            foot: 'Concept &amp; design direction'
          })
        },
        {
          label: 'Budget',
          alt: 'Sample report page: a $25,000 preliminary budget for a fictional kitchen, with planning allowances and an ROQ recommendation',
          html: reportPage({
            series: 'Renovation Plan', n: '07',
            kicker: 'Chapter II &middot; Budget',
            title: 'Understanding the investment',
            sub: 'The Linden Street Kitchen &middot; Preliminary budget target $25,000',
            table: {
              cols: [{ label: 'Category' }, { label: 'Planning allowance', cls: 'pp-num' }],
              rows: [
                ['Cabinet refinishing or selective replacement', '$6,500'],
                ['Countertops', '$4,500'],
                ['Backsplash and finishes', '$2,000'],
                ['Lighting and electrical allowances', '$2,500'],
                ['Labor and installation allowances', '$5,500'],
                ['Contingency', '$4,000']
              ],
              total: ['Total', '$25,000']
            },
            note: 'Prioritize retaining the existing layout where practical, investing in durable high-visibility finishes, and confirming electrical, plumbing, and installation costs before ordering materials.',
            fine: 'Illustrative example for a fictional project. Not a verified estimate or contractor quote.'
          })
        },
        {
          label: 'Contractors',
          alt: 'Sample page: choosing the right professionals, over two builders at work',
          html: photoPage({
            img: 'renovation-execution.jpg', series: 'Renovation Plan', n: '11', shade: 0.4,
            kicker: 'Chapter III &middot; Contractors',
            title: 'The right people for the project',
            copy: 'Understand which professionals your project needs and how to evaluate qualifications, estimates, and experience.',
            foot: 'Contractor &amp; DIY guidance'
          })
        },
        {
          label: 'Roadmap',
          alt: 'Sample page: from vision to renovation, over a homeowner and contractor walking through a project',
          html: photoPage({
            img: 'renovation-roadmap.jpg', series: 'Renovation Plan', n: '14', shade: 0.4,
            kicker: 'Chapter IV &middot; Roadmap',
            title: 'From vision to renovation',
            copy: 'An organized sequence of decisions, professional consultations, purchasing, and next steps.',
            foot: 'Project roadmap'
          })
        }
      ],
      steps: [
        { name: 'Project', title: 'Tell us about your project.', fields: [
          ADDRESS,
          { id: 'room', type: 'radio', label: 'Which project is this plan for?', short: 'Project',
            options: ['Kitchen', 'Bathroom', 'Basement', 'Living room', 'Laundry room', 'Home office', 'Another room or project'],
            error: 'Please choose the project.' },
          { id: 'changes', type: 'textarea', label: 'What would you like to change?', short: 'Desired changes', max: 1000,
            hint: 'What’s not working today, and what you’d like the space to do…',
            error: 'Please tell us what you would like to change.' },
          { id: 'style', type: 'text', label: 'Style and design preferences', short: 'Style', optional: true, max: 200,
            hint: 'e.g. warm modern, light oak, matte black fixtures' },
          { id: 'info', type: 'textarea', label: 'Anything else about the space', short: 'Project info', optional: true, max: 800,
            hint: 'Approximate size, what should stay, links to photos or inspiration…',
            note: 'You can also reply to our email with photos of the space.' }
        ] },
        { name: 'Plans', title: 'Budget, timing, and help.', fields: [
          { id: 'budget', type: 'radio', label: 'Approximate project budget', short: 'Budget',
            options: BUDGETS_199, error: 'Please choose an approximate budget.' },
          { id: 'when', type: 'radio', label: 'When would you like to start?', short: 'Timeline',
            options: ['Within 3 months', '3–6 months', '6–12 months', 'Just exploring'],
            error: 'Please choose a timeline.' },
          { id: 'diy', type: 'radio', label: 'How much would you like to do yourself?', short: 'DIY',
            options: ['Hire out everything', 'Open to some DIY', 'Plan to do much of it myself', 'Not sure yet'],
            error: 'Please choose how much you would like to do yourself.' },
          { id: 'contractors', type: 'radio', label: 'Do you already have contractor candidates?', short: 'Contractors',
            options: ['Yes', 'Not yet'],
            error: 'Please let us know if you have contractor candidates.' }
        ] },
        { name: 'Details', title: 'Your details', fields: CONTACT }
      ]
    }
  };

  /* ---------- Overlay ---------- */

  var MAX_STEPS = 3;
  var root, panel, stage, book, thumbs, side, zoom, zoomPage, zoomCount, views = {};
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

  function plain(s) {
    var d = document.createElement('div');
    d.innerHTML = s;
    return d.textContent;
  }

  function build() {
    var stepViews = '';
    for (var i = 0; i < MAX_STEPS; i++) stepViews += '<section class="pp-view" data-view="step' + i + '"></section>';

    root = el('div', 'pp');
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
      '<div class="pp-panel" role="dialog" aria-modal="true" aria-labelledby="ppTitle">' +
        '<button type="button" class="pp-close" aria-label="Close">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" /></svg>' +
        '</button>' +
        '<div class="pp-stage">' +
          '<div class="pp-book-wrap">' +
            '<figure class="pp-book" aria-live="polite"></figure>' +
            '<button type="button" class="pp-enlarge" aria-label="Enlarge sample page">' +
              '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5" /></svg>' +
            '</button>' +
          '</div>' +
          '<ul class="pp-thumbs" aria-label="Sample pages"></ul>' +
          '<p class="pp-sample-note">Sample publication shown for illustration. Your plan is prepared for your home.</p>' +
        '</div>' +
        '<div class="pp-side">' +
          '<section class="pp-view" data-view="preview"></section>' +
          stepViews +
          '<section class="pp-view" data-view="review"></section>' +
          '<section class="pp-view" data-view="terms"></section>' +
          '<section class="pp-view pp-done" data-view="done"></section>' +
        '</div>' +
        '<div class="pp-zoom" role="dialog" aria-label="Enlarged sample page" hidden>' +
          '<button type="button" class="pp-zoom-close" aria-label="Close enlarged page">' +
            '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2l12 12M14 2L2 14" /></svg>' +
          '</button>' +
          '<div class="pp-zoom-page"></div>' +
          '<div class="pp-zoom-bar">' +
            '<button type="button" class="pp-zoom-nav" data-dir="-1" aria-label="Previous page">' +
              '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg></button>' +
            '<span class="pp-zoom-count"></span>' +
            '<button type="button" class="pp-zoom-nav" data-dir="1" aria-label="Next page">' +
              '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg></button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(root);

    panel = root.querySelector('.pp-panel');
    stage = root.querySelector('.pp-stage');
    book = root.querySelector('.pp-book');
    thumbs = root.querySelector('.pp-thumbs');
    side = root.querySelector('.pp-side');
    zoom = root.querySelector('.pp-zoom');
    zoomPage = root.querySelector('.pp-zoom-page');
    zoomCount = root.querySelector('.pp-zoom-count');
    root.querySelectorAll('.pp-view').forEach(function (v) { views[v.dataset.view] = v; });

    root.querySelector('.pp-close').addEventListener('click', close);
    root.addEventListener('mousedown', function (e) { if (e.target === root) close(); });
    root.addEventListener('keydown', onKeydown);

    book.addEventListener('click', openZoom);
    root.querySelector('.pp-enlarge').addEventListener('click', openZoom);
    root.querySelector('.pp-zoom-close').addEventListener('click', closeZoom);
    zoom.addEventListener('click', function (e) { if (e.target === zoom) closeZoom(); });
    root.querySelectorAll('.pp-zoom-nav').forEach(function (b) {
      b.addEventListener('click', function () { stepZoom(+b.dataset.dir); });
    });
  }

  function onKeydown(e) {
    var zoomed = zoom && !zoom.hidden;
    if (e.key === 'Escape') { e.preventDefault(); if (zoomed) closeZoom(); else close(); return; }
    if (zoomed && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      stepZoom(e.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (e.key !== 'Tab') return;
    // Keep focus inside the dialog, or inside the enlarged page while it is open.
    var scope = zoomed ? zoom : panel;
    var f = Array.prototype.filter.call(
      scope.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'),
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
    if (from !== undefined) trigger = from || null;
    closeZoom(true);

    if (!plan || plan.key !== key) {
      plan = PLANS[key];
      renderPublication();
      renderPreview();
    }
    if (!data[key]) data[key] = {};

    // A finished request starts fresh next time; otherwise reopen where they
    // left off. Answers are kept per plan, so moving between plans loses nothing.
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
    closeZoom(true);
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
      btn.setAttribute('aria-label', 'Show sample page: ' + plain(p.label));
      var mini = el('span', 'pp-thumb-page', p.html);
      mini.setAttribute('aria-hidden', 'true');
      btn.appendChild(mini);
      btn.appendChild(el('span', 'pp-thumb-label', p.label));
      btn.addEventListener('click', function () { showPage(i); });
      li.appendChild(btn);
      thumbs.appendChild(li);
    });
    thumbs.scrollLeft = 0;
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

  /* ---------- Enlarged page ----------
     The sample pages are sized in cqw, so the same markup renders legibly
     at full screen; this is how the report pages are read on a phone. */

  function openZoom() {
    renderZoom();
    zoom.hidden = false;
    root.classList.add('is-zoomed');
    zoom.querySelector('.pp-zoom-close').focus();
  }

  function renderZoom() {
    var p = plan.pages[pageIndex];
    zoomPage.innerHTML = p.html;
    zoomPage.setAttribute('aria-label', p.alt);
    zoomPage.setAttribute('role', 'img');
    zoomCount.textContent = (pageIndex + 1) + ' / ' + plan.pages.length;
  }

  function stepZoom(dir) {
    var n = plan.pages.length;
    showPage((pageIndex + dir + n) % n);
    renderZoom();
  }

  function closeZoom(silent) {
    if (!zoom || zoom.hidden) return;
    zoom.hidden = true;
    zoomPage.innerHTML = '';
    root.classList.remove('is-zoomed');
    if (silent !== true) root.querySelector('.pp-enlarge').focus();
  }

  /* ---------- Views ---------- */

  function show(name) {
    root.dataset.state = name;
    Object.keys(views).forEach(function (k) { views[k].classList.toggle('is-active', k === name); });
    root.classList.toggle('is-intake', name !== 'preview');
    if (name.indexOf('step') === 0) renderStep(+name.slice(4));
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
    var names = plan.steps.map(function (s) { return s.name; }).concat('Review');
    return '<ol class="pp-steps" aria-label="Progress">' + names.map(function (n, i) {
      var cls = i < current ? ' class="is-done"' : '';
      var cur = i === current ? ' aria-current="step"' : '';
      return '<li' + cls + cur + '>' + (i + 1) + ' &middot; ' + n + '</li>';
    }).join('') + '</ol>';
  }

  function priceText(p) {
    return p.priceLabel ? p.price + ' &middot; ' + p.priceLabel : 'Starting at ' + p.price;
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
        // An item is a title, or { t: title, d: one-line description }.
        var body = typeof t === 'string' ? t : '<div>' + t.t + '<small>' + t.d + '</small></div>';
        return '<li><span>0' + (i + 1) + '</span>' + body + '</li>';
      }).join('') + '</ul>' +
      (plan.excluded ?
        '<details class="pp-excluded"><summary>What&rsquo;s not included</summary><ul>' +
          plan.excluded.map(function (t) { return '<li>' + t + '</li>'; }).join('') +
        '</ul></details>' : '') +
      '<div class="pp-buy">' +
        '<div><span class="pp-price-label">' + (plan.priceLabel || 'Starting at') + '</span>' +
          '<span class="pp-price">' + plan.price + '</span></div>' +
        '<button type="button" class="pp-btn" data-go="step0">Start My Plan</button>' +
      '</div>' +
      (plan.cross ?
        '<p class="pp-cross">' + plan.cross.text + ' <button type="button" class="pp-link" data-switch="' +
          plan.cross.to + '">' + plan.cross.link + '</button></p>' : '') +
      '<p class="pp-fine">' + plan.fine +
        (plan.checkout ? ' <a class="pp-link" href="' + TERMS_URL + '" target="_blank" rel="noopener" data-terms>Terms &amp; refund policy</a>' : '') + '</p>';
    v.querySelector('[data-go]').addEventListener('click', function () { show('step0'); });
    bindTerms(v);
    var sw = v.querySelector('[data-switch]');
    if (sw) sw.addEventListener('click', function () { open(sw.dataset.switch); });
  }

  function fieldHtml(f, value) {
    var name = 'pp-' + f.id;
    if (f.type === 'radio' || f.type === 'checks') {
      var input = f.type === 'radio' ? 'radio' : 'checkbox';
      var chosen = [].concat(value || []);
      return '<fieldset class="pp-fieldset" data-field="' + f.id + '"><legend class="pp-legend">' + f.label + '</legend>' +
        '<div class="pp-choices">' + f.options.map(function (o) {
          return '<label class="pp-choice' + (input === 'checkbox' ? ' pp-choice--check' : '') + '">' +
            '<input type="' + input + '" name="' + name + '" value="' + esc(o) + '"' +
            (chosen.indexOf(o) > -1 ? ' checked' : '') + ' />' + esc(o) + '</label>';
        }).join('') + '</div></fieldset>';
    }
    var optional = f.optional ? ' <small>(optional)</small>' : '';
    var attrs = ' id="' + name + '" name="' + name + '" maxlength="' + (f.max || 200) + '"' +
      (f.auto ? ' autocomplete="' + f.auto + '"' : '') +
      (f.hint ? ' placeholder="' + esc(f.hint) + '"' : '') +
      (f.optional ? '' : ' required');
    var control = f.type === 'textarea'
      ? '<textarea class="pp-input"' + attrs + '>' + esc(value || '') + '</textarea>'
      : '<input class="pp-input" type="' + f.type + '"' + attrs + ' value="' + esc(value || '') + '" />';
    return '<div class="pp-field" data-field="' + f.id + '"><label class="pp-label" for="' + name + '">' + f.label + optional + '</label>' +
      control + (f.note ? '<p class="pp-field-note">' + f.note + '</p>' : '') + '</div>';
  }

  function readField(form, f) {
    var name = 'pp-' + f.id;
    if (f.type === 'radio') {
      var r = form.querySelector('[name="' + name + '"]:checked');
      return r ? r.value : '';
    }
    if (f.type === 'checks') {
      return Array.prototype.map.call(form.querySelectorAll('[name="' + name + '"]:checked'), function (c) { return c.value; });
    }
    return form[name].value.trim();
  }

  // Returns an error message, or '' when the value is acceptable.
  function check(f, v) {
    var empty = !v || (Array.isArray(v) && !v.length);
    if (empty) return f.optional ? '' : (f.error || 'Please complete this field.');
    if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return f.error;
    if (f.type === 'tel' && v.replace(/\D/g, '').length < 10) return f.error;
    if (f.min && v.length < f.min) return f.error;
    return '';
  }

  function renderStep(i) {
    var s = plan.steps[i];
    var d = data[plan.key];
    var v = views['step' + i];
    var last = i === plan.steps.length - 1;
    v.innerHTML =
      steps(i) +
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">' + s.title + '</h2>' +
      '<form novalidate>' +
        s.fields.map(function (f) { return fieldHtml(f, d[f.id]); }).join('') +
        '<p class="pp-error" role="alert"></p>' +
        '<div class="pp-actions">' +
          '<button type="button" class="pp-btn pp-btn--quiet" data-back>Back</button>' +
          '<button type="submit" class="pp-btn">' + (last ? 'Review' : 'Continue') + '</button>' +
        '</div>' +
      '</form>';

    var form = v.querySelector('form');
    function read() { s.fields.forEach(function (f) { d[f.id] = readField(form, f); }); }
    form.addEventListener('input', function (e) { read(); e.target.removeAttribute('aria-invalid'); });
    form.addEventListener('change', read);
    v.querySelector('[data-back]').addEventListener('click', function () {
      read();
      show(i === 0 ? 'preview' : 'step' + (i - 1));
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      read();
      var err = form.querySelector('.pp-error');
      for (var k = 0; k < s.fields.length; k++) {
        var f = s.fields[k], msg = check(f, d[f.id]);
        if (msg) return fail(err, msg, form.querySelector('[name="pp-' + f.id + '"]'));
      }
      show(last ? 'review' : 'step' + (i + 1));
    });
  }

  function display(v) {
    return Array.isArray(v) ? v.join(', ') : v;
  }

  function renderReview() {
    var d = data[plan.key];
    var v = views.review;
    var pay = paid(plan);
    var label = pay ? 'Continue to Payment' : 'Submit Request';
    var notice = reviewNotice;
    reviewNotice = '';
    function row(k, val) { return '<dt>' + k + '</dt><dd>' + esc(val || '—') + '</dd>'; }
    v.innerHTML =
      steps(plan.steps.length) +
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">Review your request</h2>' +
      '<div class="pp-review">' +
        '<div class="pp-review-group"><div class="pp-review-head"><h4>Service</h4></div><dl>' +
          row('Plan', plan.name) + row('Price', plain(priceText(plan))) + '</dl></div>' +
        plan.steps.map(function (s, i) {
          return '<div class="pp-review-group"><div class="pp-review-head"><h4>' + s.name + '</h4>' +
            '<button type="button" class="pp-edit" data-edit="step' + i + '" aria-label="Edit ' + s.name.toLowerCase() + '">Edit</button></div><dl>' +
            s.fields.map(function (f) { return row(f.short, display(d[f.id])); }).join('') + '</dl></div>';
        }).join('') +
      '</div>' +
      '<p class="pp-submit-note">' + (pay
        ? 'Next, you&rsquo;ll pay ' + plan.price + ' securely through Stripe. We&rsquo;ll begin once your payment is confirmed and follow up by email. ' +
          'By continuing, you agree to the <a class="pp-link" href="' + TERMS_URL + '" target="_blank" rel="noopener" data-terms>Home Plan Terms &amp; Refund Policy</a>.'
        : 'No payment is due today. We&rsquo;ll review your request and follow up by email with next steps.') + '</p>' +
      (notice ? '<p class="pp-notice">' + notice + '</p>' : '') +
      '<p class="pp-error" role="alert"></p>' +
      '<div class="pp-actions">' +
        '<button type="button" class="pp-btn pp-btn--quiet" data-back>Back</button>' +
        '<button type="button" class="pp-btn" data-submit>' + label + '</button>' +
      '</div>';

    v.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { show(b.dataset.edit); });
    });
    v.querySelector('[data-back]').addEventListener('click', function () { show('step' + (plan.steps.length - 1)); });
    bindTerms(v);
    var btn = v.querySelector('[data-submit]');
    btn.addEventListener('click', function () {
      var err = v.querySelector('.pp-error');
      err.classList.remove('is-visible');
      btn.disabled = true;
      btn.textContent = pay ? 'Opening checkout…' : 'Sending…';
      var sent = plan;
      if (pay) {
        startCheckout(sent, d).catch(function (e) {
          btn.disabled = false;
          btn.textContent = label;
          fail(err, e.message || 'Could not start checkout. Please try again.');
        });
        return;
      }
      submitRequest(sent, d).then(function () {
        submitted[sent.key] = true;
        if (plan !== sent) return;
        renderDone(d);
        show('done');
      }).catch(function (e) {
        btn.disabled = false;
        btn.textContent = label;
        fail(err, e.message || 'Could not send your request. Please try again.');
      });
    });
  }

  /* Terms open inside the overlay, so the customer reads them without
     losing their place: Back returns to the step they came from, and the
     main button carries on (Start My Plan, or straight to payment). The text
     is pulled from the terms page itself, so there is one copy to maintain.
     A modified click, or a failed fetch, still opens the page in a new tab. */

  var termsFrom = 'review';
  var termsHtml = null;

  function bindTerms(v) {
    v.querySelectorAll('[data-terms]').forEach(function (a) { a.addEventListener('click', openTerms); });
  }

  function loadTerms() {
    if (termsHtml) return Promise.resolve(termsHtml);
    return fetch(TERMS_URL).then(function (res) {
      if (!res.ok) throw new Error('terms');
      return res.text();
    }).then(function (html) {
      var main = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
      if (!main) throw new Error('terms');
      main.querySelectorAll('.doc-title, .doc-heading').forEach(function (n) { n.remove(); });
      main.querySelectorAll('h2').forEach(function (h) {
        var h3 = document.createElement('h3');
        h3.className = h.className;
        h3.innerHTML = h.innerHTML;
        h.replaceWith(h3);
      });
      main.querySelectorAll('a[href]').forEach(function (a) {
        a.href = new URL(a.getAttribute('href'), location.origin + TERMS_URL).href;
        a.target = '_blank';
        a.rel = 'noopener';
      });
      termsHtml = main.innerHTML;
      return termsHtml;
    });
  }

  function openTerms(e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    var from = root.dataset.state;
    loadTerms().then(function (html) {
      termsFrom = from;
      renderTerms(html);
      show('terms');
    }, function () { window.open(TERMS_URL, '_blank', 'noopener'); });
  }

  function renderTerms(html) {
    var fromReview = termsFrom === 'review';
    var next = fromReview ? (paid(plan) ? 'Continue to Payment' : 'Submit Request') : 'Start My Plan';
    var v = views.terms;
    v.innerHTML =
      '<p class="pp-eyebrow">' + plan.name + ' &middot; ' + plan.price + '</p>' +
      '<h2 class="pp-step-title" id="ppTitle" style="margin-top:12px">Home Plan Terms &amp; Refund Policy</h2>' +
      '<div class="pp-terms">' + html + '</div>' +
      '<div class="pp-actions">' +
        '<button type="button" class="pp-btn pp-btn--quiet" data-back>' + (fromReview ? 'Back to Review' : 'Back') + '</button>' +
        '<button type="button" class="pp-btn" data-next>' + next + '</button>' +
      '</div>';
    v.querySelector('[data-back]').addEventListener('click', function () { show(termsFrom); });
    v.querySelector('[data-next]').addEventListener('click', function () {
      if (!fromReview) { show('step0'); return; }
      // Hand off to the review step's own button, so payment starts (and any
      // error shows) exactly as if it had been clicked there.
      show('review');
      views.review.querySelector('[data-submit]').click();
    });
  }

  function renderDone(d, wasPaid) {
    var first = (d.name || '').split(/\s+/)[0];
    var to = d.email ? ' at <strong>' + esc(d.email) + '</strong>' : ' by email';
    views.done.innerHTML =
      '<p class="pp-eyebrow">' + plan.name + '</p>' +
      '<h2 class="pp-title" id="ppTitle">Thank you' + (first ? ', ' + esc(first) : '') + '.</h2>' +
      '<p class="pp-lede">' + (wasPaid
        ? 'Your payment is complete and your ' + plan.name + ' is underway. We&rsquo;ve sent a confirmation' + to + ', and your plan will arrive within 5 business days.'
        : 'Your request is in. We&rsquo;ll review it and follow up' + to + ' with next steps.') + '</p>' +
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
     project_type, which is the line the notification email leads with: the
     plan and price, then the first answer unlabelled, then the rest. */

  function allFields(p) {
    var fields = [];
    p.steps.forEach(function (s) { fields = fields.concat(s.fields); });
    return fields;
  }

  function addressOf(p, d) {
    var addrField = allFields(p).filter(function (f) { return f.address; })[0];
    return addrField ? d[addrField.id] || '' : '';
  }

  function summaryOf(p, d) {
    var fields = allFields(p);

    // The first answer after the address leads, unlabelled. Optional
    // questions left blank are dropped to keep the email readable.
    var lead = fields.filter(function (f) { return f.id !== 'address'; })[0];
    var parts = [p.name + ' (' + p.price + ')'];
    fields.forEach(function (f) {
      if (f.id === 'email' || f.id === 'address') return;   // sent as contact / address
      var val = display(d[f.id]);
      if (!val && f.optional && f.id !== 'phone' && f.id !== 'location') return;
      parts.push(f === lead ? val : f.short + ': ' + (val || '—'));
    });
    return parts.join(' | ');
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (b) {
        if (!res.ok || b.error) throw new Error(b.error || 'Something went wrong. Please try again.');
        return b;
      });
    }, function () {
      throw new Error('We couldn’t reach our server. Check your connection and try again.');
    });
  }

  function submitRequest(p, d) {
    var loc = addressOf(p, d);
    var address = !loc ? 'Not provided' : (loc.length >= 8 ? loc : loc + ' (as entered)');
    return fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ address: address, project_type: summaryOf(p, d), contact: d.email, contact_method: 'email' })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (!res.ok || !body.ok) throw new Error(body.error || 'Could not send your request. Please try again.');
      });
    }, function () {
      throw new Error('We couldn’t reach our server. Check your connection and try again.');
    });
  }

  /* ---------- Stripe checkout ----------
     The answers are kept in sessionStorage across the trip to Stripe, so a
     cancelled checkout comes back to the review step with nothing lost. */

  var DRAFT = 'roq-plan-draft-';
  var reviewNotice = '';

  function store(fn) { try { return fn(window.sessionStorage); } catch (e) { return null; } }

  function paid(p) {
    return !!p.checkout && (CHECKOUT_LIVE || store(function (s) { return s.getItem('roq-pay-test') === '1'; }) === true);
  }

  function startCheckout(p, d) {
    store(function (s) { s.setItem(DRAFT + p.key, JSON.stringify(d)); });
    return post(CHECKOUT_URL, {
      plan: p.key,
      address: addressOf(p, d),
      email: d.email,
      summary: summaryOf(p, d),
      intake: d,
      origin: location.origin
    }).then(function (b) {
      if (!b.url) throw new Error('Could not start checkout. Please try again.');
      location.assign(b.url);
    });
  }

  function resumeFromCheckout() {
    var q = new URLSearchParams(location.search);
    if (q.get('pay') === 'test') store(function (s) { s.setItem('roq-pay-test', '1'); });
    var result = q.get('checkout');
    if (result !== 'success' && result !== 'cancelled') return;

    // Back from Stripe: this page's plan is the one its Learn more button opens.
    var b = document.querySelector('[data-plan-preview]');
    var key = b && b.getAttribute('data-plan-preview');
    if (!PLANS[key]) return;
    var draft = store(function (s) { return JSON.parse(s.getItem(DRAFT + key) || 'null'); }) || {};

    q.delete('checkout');
    q.delete('session_id');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);

    if (result === 'success') {
      store(function (s) { s.removeItem(DRAFT + key); });
      open(key, b);
      submitted[key] = true;
      renderDone(draft, true);
      show('done');
    } else {
      data[key] = draft;
      reviewNotice = 'Checkout was cancelled, so you haven&rsquo;t been charged. Your answers are saved below.';
      open(key, b);
      show(draft.email ? 'review' : 'preview');
    }
  }

  /* ---------- Wire up the existing Learn more buttons ---------- */

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-plan-preview]');
    if (!b) return;
    e.preventDefault();
    open(b.getAttribute('data-plan-preview'), b);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resumeFromCheckout);
  else resumeFromCheckout();

  window.ROQPlanPreview = { open: open, close: close };
})();
