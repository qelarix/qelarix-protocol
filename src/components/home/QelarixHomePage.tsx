'use client';

// Qelarix Home Page — 1:1 port of the STATIC source homepage (Qelarix_Home_Page/index.html + src/styles.css),
// which is the visual truth (qelarix.ai reference). Markup/classes/copy mirror index.html exactly, except:
//  - the source <header class="site-header"> is OMITTED (the app's global <Header/> renders the nav — no second header);
//  - the hero preview switcher (source script.js) is re-implemented with React state (same 4 previews, same behavior);
//  - asset paths point to /public (PNG/JPG posters only — NO videos, exactly like the source markup);
//  - obvious links use real routes via next/link; everything else stays "#" like the source.
// Styling lives in src/app/qelarix-home.css — the source styles.css scoped under .qhx-home.

import { useEffect, useState } from 'react';
import Link from 'next/link';

const creatorCamera = '/home/cards/creator-camera.png';
const robotRunway = '/home/cards/robot-runway.png';
const portalLondon = '/home/cards/portal-london.png';
const samuraiRain = '/home/cards/samurai-rain.png';
const cityDome = '/home/cards/city-dome.png';
const notesShot = '/home/notes.png';
const exampleImageLab = '/home/qelarix-1778978751310.jpg';
const exampleCampaign = '/home/qelarix_image_088.jpg';
const qelarixLogo = '/qelarix_logo.png';

// Hero preview items — identical to the source script.js `previews` array (4 items incl. Storyboard).
const previews = [
  { label: 'AI Playground', title: 'Prompt to polished cinematic output', poster: creatorCamera },
  { label: 'Cinema Studio', title: 'Directed scenes with camera control', poster: portalLondon },
  { label: 'Viral Mode', title: 'Fast clips for campaigns and social hooks', poster: samuraiRain },
  { label: 'Script to Video', title: 'Plan visual scenes before final render', poster: cityDome },
];

export const QelarixHomePage = () => {
  const [activePreview, setActivePreview] = useState(0);
  // Source script.js behavior: the toggle starts as "Playground preview" and becomes "<label> preview" after a click.
  const [toggleText, setToggleText] = useState('Playground preview');
  const preview = previews[activePreview];

  // Scroll reveal: sections below the hero ease in as they enter the viewport.
  useEffect(() => {
    const sections = Array.from(document.querySelectorAll<HTMLElement>('.qhx-home main > section:not(.hero)'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    sections.forEach((el) => el.classList.add('reveal'));
    const io = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }
      }),
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' },
    );
    sections.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const selectPreview = (index: number) => {
    setActivePreview(index);
    setToggleText(`${previews[index].label} preview`);
  };

  return (
    <div className="qhx-home">
      <div className="background-fx" aria-hidden="true">
        <span className="dust-wash dust-a"></span>
        <span className="dust-wash dust-b"></span>
        <span className="light-thread thread-a"><span className="thread-spark"></span></span>
        <span className="light-thread thread-b"><span className="thread-spark"></span></span>
        <span className="light-thread thread-c"><span className="thread-spark"></span></span>
        <span className="light-thread thread-d"></span>
      </div>

      <main>
        <section className="hero section-shell" id="top">
          <div className="main-slogan" aria-label="Qelarix main slogan">
            <span className="hero-eyebrow">Qelarix Protocol · Built on Solana</span>
            <h2>Create beyond <span>imagination</span></h2>
            <p className="slogan-sub">Images, video, audio and cinema in one studio. Pay per creation in QLC, settled on Solana.</p>
            <div className="slogan-actions">
              <Link href="/playground">Start creating</Link>
              <Link className="slogan-secondary" href="/pricing">See pricing</Link>
            </div>
            <span className="live-chip"><i aria-hidden="true"></i>Live on Solana devnet</span>
          </div>
          <div className="hero-copy">
            <p className="kicker">AI video, image, audio and cinema tools</p>
            <h1>Qelarix AI Creation Platform</h1>
            <p className="hero-text">
              Generate cinematic videos, premium images, voice, music and storyboards with leading AI models in one clean creative workspace.
            </p>
            <div className="hero-stats" aria-label="Qelarix highlights">
              <span><strong>30+</strong> AI models</span>
              <span><strong>AI tools</strong> &amp; studios</span>
              <span><strong>4K</strong> cinematic output</span>
            </div>
          </div>

          <div className="hero-visual" aria-label="Qelarix homepage product preview">
            <div className="preview-stage">
              <article className="hero-video-card liquid-glass">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={preview.poster} alt="" decoding="async" />
                <div className="media-shade"></div>
                <div className="hero-video-content">
                  <span>{preview.label}</span>
                  <strong>{preview.title}</strong>
                </div>
              </article>

              <article className="floating-folder folder-one liquid-glass">
                <span>Model folder</span>
                <strong>Seedance 2.0</strong>
                <small>Image concepts ready</small>
              </article>

              <article className="floating-folder folder-two liquid-glass">
                <span>Cinema setup</span>
                <strong>Kling 3.0</strong>
                <small>Camera move, 4K, audio</small>
              </article>

              <div className="floating-dropdown liquid-glass" aria-label="Preview selector">
                <button type="button">{toggleText}</button>
                <div className="preview-list">
                  {previews.map((item, index) => (
                    <button
                      key={item.label}
                      type="button"
                      className={index === activePreview ? 'is-active' : ''}
                      onClick={() => selectPreview(index)}
                    >
                      <span>{item.label}</span>
                      <strong>{item.title}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="protocol section-shell" id="protocol" aria-label="Qelarix Protocol on Solana">
          <div className="section-heading split">
            <div>
              <p>Qelarix Protocol</p>
              <h2>Creative AI, settled on Solana.</h2>
            </div>
            <span className="section-note">Running on Solana devnet during the beta.</span>
          </div>
          <div className="protocol-grid">
            <article className="protocol-card liquid-glass">
              <span>01</span>
              <h3>QLC token</h3>
              <p>On-chain credits issued as a Solana Token-2022 token. Your balance lives in your wallet.</p>
            </article>
            <article className="protocol-card liquid-glass">
              <span>02</span>
              <h3>Pay per creation</h3>
              <p>Each generation reserves its QLC cost before it runs and settles only on success. Failed generations are refunded automatically.</p>
            </article>
            <article className="protocol-card liquid-glass">
              <span>03</span>
              <h3>You set the limit</h3>
              <p>Approve a spending limit once. Change it or turn it off at any time.</p>
            </article>
            <article className="protocol-card liquid-glass">
              <span>04</span>
              <h3>Sign in with Solana</h3>
              <p>Connect your wallet and sign a message. No password needed.</p>
            </article>
          </div>
        </section>

        <section className="featured section-shell" id="featured">
          <div className="section-heading split">
            <div>
              <p>Featured</p>
              <h2>Start from a real Qelarix generation path.</h2>
            </div>
            <Link href="/explore">View all</Link>
          </div>

          {/* Featured cards are real entry points: identical markup/classes, now navigable (grid/flex children
              render the same as <article> — the scoped CSS already resets link color/decoration). */}
          <div className="featured-rail" aria-label="Featured Qelarix tools">
            <Link className="feature-card liquid-glass" href="/playground?mode=video">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={creatorCamera} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <span>Video</span>
              <h3>AI Video Studio</h3>
              <p>Text to video, image to video and cinematic motion.</p>
            </Link>

            <Link className="feature-card liquid-glass" href="/marketing">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={samuraiRain} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <span>Viral Mode</span>
              <h3>Social ready scenes</h3>
              <p>Fast visual hooks for campaigns, reels and ads.</p>
            </Link>

            <Link className="feature-card liquid-glass" href="/cinema-studio-new">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portalLondon} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <span>Cinema Studio</span>
              <h3>Directed camera shots</h3>
              <p>Control angle, style, timing and mood.</p>
            </Link>

            <Link className="feature-card liquid-glass" href="/storyboard">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cityDome} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <span>Script to Video</span>
              <h3>Script to visual plan</h3>
              <p>Map ideas before final generation.</p>
            </Link>

            <Link className="feature-card liquid-glass" href="/playground">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={robotRunway} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <span>Playground</span>
              <h3>Compare model outputs</h3>
              <p>Move between image, video and audio models quickly.</p>
            </Link>
          </div>
        </section>

        <section className="studio-overview section-shell" id="playground">
          <div className="section-heading centered">
            <p>Playground</p>
            <h2>A calm command center for every creative format.</h2>
          </div>

          <div className="studio-grid">
            <article className="studio-panel prompt-panel liquid-glass">
              <div className="panel-top">
                <span>Prompt</span>
                <strong>Describe the scene</strong>
              </div>
              <p>
                Hyper realistic product launch film, violet-blue studio lighting, glass reflections, smooth camera push in, premium brand mood.
              </p>
              <div className="mode-row">
                <button className="is-active" type="button">Image</button>
                <button type="button">Video</button>
                <button type="button">Audio</button>
                <button type="button">Script to Video</button>
              </div>
              <div className="settings-row">
                <span>Model: Kling 3.0</span>
                <span>Ratio: 16:9</span>
                <span>Quality: 4K</span>
              </div>
            </article>

            <Link className="studio-panel preview-panel liquid-glass" id="cinema" href="/cinema-studio-new">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portalLondon} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <div>
                <span>Cinema Studio</span>
                <h3>Scene direction with model control.</h3>
              </div>
            </Link>

            <Link className="studio-panel preview-panel compact liquid-glass" id="viral" href="/marketing">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={robotRunway} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <div>
                <span>Viral Mode</span>
                <h3>Short form ideas that move fast.</h3>
              </div>
            </Link>

            <article className="studio-panel folder-stack liquid-glass">
              <div className="folder-card">
                <span>01</span>
                <strong>Prompt pack</strong>
              </div>
              <div className="folder-card">
                <span>02</span>
                <strong>Reference images</strong>
              </div>
              <div className="folder-card">
                <span>03</span>
                <strong>Final renders</strong>
              </div>
            </article>
          </div>
        </section>

        <section className="models-section section-shell" id="models">
          <div className="section-heading split">
            <div>
              <p>Featured models</p>
              <h2>Premium AI models, one Qelarix account.</h2>
            </div>
            <span className="section-note">Image, video and audio models in one workflow.</span>
          </div>

          <div className="model-marquee liquid-glass" aria-label="Featured model names">
            <div className="marquee-track">
              <span>Seedream</span>
              <span>Nano Banana Pro</span>
              <span>FLUX 2 Pro</span>
              <span>GPT Image 2</span>
              <span>Grok Imagine</span>
              <span>Kling</span>
              <span>Seedance</span>
              <span>Veo</span>
              <span>Sora</span>
              <span>Luma</span>
              <span>Pika</span>
              <span>Wan</span>
              <span>Seedream</span>
              <span>Nano Banana Pro</span>
              <span>FLUX 2 Pro</span>
              <span>GPT Image 2</span>
              <span>Grok Imagine</span>
              <span>Kling</span>
            </div>
          </div>

          {/* Product-entry cards: Image/Video open the Playground in the matching mode; Audio keeps its current surface. */}
          <div className="model-grid">
            <Link className="model-card liquid-glass" href="/playground?mode=image">
              <span>Image</span>
              <strong>Brand stills and concepts</strong>
              <p>Generate characters, products, thumbnails and editorial images with a polished interface.</p>
            </Link>
            <Link className="model-card liquid-glass" href="/playground?mode=video">
              <span>Video</span>
              <strong>Cinematic generation</strong>
              <p>Create motion from text or images using models made for camera language and mood.</p>
            </Link>
            <Link className="model-card liquid-glass" href="/audio">
              <span>Audio</span>
              <strong>Voice, music and sound</strong>
              <p>Add the sound layer without leaving the Qelarix creative flow.</p>
            </Link>
          </div>

          <section className="playground-ad liquid-glass" aria-label="Playground notes advertisement">
            <div className="playground-ad-media notes-shot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={notesShot} alt="Qelarix Playground notes" loading="lazy" decoding="async" />
            </div>
            <div className="playground-ad-copy">
              <span>Playground notes</span>
              <h2>Make your notes, write your idea, play with it and make it happen.</h2>
              <p>
                Collect every spark in one place, shape it with models, then turn notes into images,
                scenes, audio and campaign-ready outputs.
              </p>
              <Link className="secondary-button" href="/playground">Open Playground</Link>
            </div>
            <div className="playground-ad-media video-shot">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={notesShot} alt="" loading="lazy" decoding="async" />
            </div>
          </section>
        </section>

        <section className="examples section-shell" id="examples">
          <div className="section-heading centered">
            <h2>Cinematic AI worlds, campaigns and scenes in motion.</h2>
          </div>

          <div className="examples-grid">
            <Link className="example-card large video-fit kingdom-fit liquid-glass" href="/explore">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cityDome} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <div>
                <span>World building</span>
                <strong>The Giant Beneath Paris</strong>
              </div>
            </Link>

            <Link className="example-card liquid-glass" href="/explore">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={exampleImageLab} alt="Qelarix generated image example" loading="lazy" decoding="async" />
              <div>
                <span>Image Lab</span>
                <strong>Premium visual concepts</strong>
              </div>
            </Link>

            <Link className="example-card video-fit right-video-fit liquid-glass" href="/explore">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={samuraiRain} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <div>
                <span>Video</span>
                <strong>Epic creature scene</strong>
              </div>
            </Link>

            <Link className="example-card liquid-glass" href="/explore">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={exampleCampaign} alt="Qelarix generated campaign image" loading="lazy" decoding="async" />
              <div>
                <span>Campaign</span>
                <strong>Sharp brand imagery</strong>
              </div>
            </Link>

            <Link className="example-card video-fit right-video-fit liquid-glass" href="/explore">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={portalLondon} alt="" loading="lazy" decoding="async" />
              <div className="media-shade"></div>
              <div>
                <span>Cinema</span>
                <strong>Lighting and atmosphere</strong>
              </div>
            </Link>
          </div>
        </section>

        <section className="apps section-shell" id="creative-tools">
          <div className="section-heading split">
            <div>
              <p>Qelarix Apps</p>
              <h2>Creative Tools</h2>
            </div>
            <span className="section-note">Fast one-shot tools for editing, video, lip sync, and production workflows.</span>
          </div>

          <div className="apps-grid">
            <Link className="app-card liquid-glass" href="/apps/video-tools">
              <span>Live</span>
              <strong>Video Tools</strong>
              <p>Upscale, extend, and enhance videos with production-ready workflows.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/apps/lip-sync">
              <span>Live</span>
              <strong>Lip Sync</strong>
              <p>Sync voice and face movement for avatars, characters, and video scenes.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/apps/watermark-remover">
              <span>Live</span>
              <strong>Watermark Remover</strong>
              <p>Clean up images and videos with a focused removal workflow.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/apps">
              <span>Hub</span>
              <strong>Browse Apps</strong>
              <p>Explore all Qelarix Creative Tools, templates, and workflow apps.</p>
            </Link>
          </div>

          <div style={{ marginTop: 22, display: 'flex', justifyContent: 'center' }}>
            <Link className="secondary-button" href="/apps">Browse all Creative Tools</Link>
          </div>
        </section>

        <section className="apps section-shell" id="apps">
          <div className="section-heading split">
            <div>
              <p>Products</p>
              <h2>Major Qelarix studios and products.</h2>
            </div>
          </div>

          <div className="apps-grid">
            <Link className="app-card liquid-glass" href="/ai-influencer">
              <span>Influencer</span>
              <strong>Consistent AI creators</strong>
              <p>Build a recognizable character style for campaigns and social content.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/storyboard">
              <span>Script to Video</span>
              <strong>Script to scenes</strong>
              <p>Plan a full video before generating the final clips.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/marketing">
              <span>Viral Mode</span>
              <strong>Marketing clips</strong>
              <p>Turn product ideas into fast moving ad concepts.</p>
            </Link>
            <Link className="app-card liquid-glass" href="/audio">
              <span>Audio</span>
              <strong>Voice and sound</strong>
              <p>Complete the creative piece with voice, music and sound design.</p>
            </Link>
          </div>
        </section>

        <section className="final-cta section-shell liquid-glass">
          <div>
            <p>Qelarix</p>
            <h2>Turn your next idea into a finished image, video, sound or story, all inside one creative AI workspace.</h2>
          </div>
          <Link className="primary-button" href="/playground">Start creating</Link>
        </section>
      </main>

      <footer className="site-footer">
        <div className="footer-inner section-shell">
          <div className="footer-grid">
            <div className="footer-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qelarixLogo} alt="Qelarix" />
              <p>
                Qelarix is a professional AI creation platform for generating images, videos,
                audio, logos and characters &mdash; designed to turn imagination into
                production-ready content with speed, style and control.
              </p>
            </div>

            <nav className="footer-links" aria-label="Platform footer navigation">
              <h3>Platform</h3>
              <Link href="/explore">Features</Link>
              <Link href="/playground">Models</Link>
              <Link href="/pricing">Pricing</Link>
              <Link href="/community">Community</Link>
            </nav>

            <nav className="footer-links" aria-label="Company footer navigation">
              <h3>Company</h3>
              <Link href="/about">About us</Link>
              <Link href="/contact">Contact</Link>
            </nav>

            <nav className="footer-links" aria-label="Legal footer navigation">
              <h3>Legal</h3>
              <Link href="/privacy-policy">Privacy Policy</Link>
              <Link href="/terms">Terms of Service</Link>
              <Link href="/impressum">Legal notice</Link>
              <Link href="/cookie-notice">Cookie Notice</Link>
            </nav>

            <nav className="footer-links" aria-label="Social footer navigation">
              <h3>Follow</h3>
              <a href="https://x.com/qelarix" target="_blank" rel="noopener noreferrer">X</a>
              <a href="https://www.youtube.com/@Qelarix" target="_blank" rel="noopener noreferrer">YouTube</a>
              <a href="https://www.tiktok.com/@qelarix_ai" target="_blank" rel="noopener noreferrer">TikTok</a>
            </nav>
          </div>

          <div className="footer-bottom">
            <p>© 2026 Qelarix. All rights reserved.</p>
            <p>Built on Solana · Made in Europe</p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default QelarixHomePage;
