// 生成测试用 PDF，用于端到端验证导入 / 元数据 / 标注 / AI 链路。
// 用法: node scripts/make-test-pdf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'fixtures');
fs.mkdirSync(outDir, { recursive: true });

function page(title, lines) {
  return { title, lines };
}

const paperA = {
  file: 'with-doi.pdf',
  meta: {
    title: 'Observation of Gravitational Waves from a Binary Black Hole Merger',
    author: 'B. P. Abbott et al.',
    subject: 'Physical Review Letters',
  },
  pages: [
    page('Observation of Gravitational Waves from a Binary Black Hole Merger', [
      'B. P. Abbott, R. Abbott, T. D. Abbott, M. R. Abernathy, F. Acernese, K. Ackley',
      'LIGO Scientific Collaboration and Virgo Collaboration',
      '(Dated: 12 February 2016)',
      '',
      'DOI: 10.1103/PhysRevLett.116.061102',
      'Phys. Rev. Lett. 116, 061102 - Published 11 February 2016',
      '',
      'ABSTRACT',
      'On September 14, 2015 at 09:50:45 UTC the two detectors of the Laser Interferometer',
      'Gravitational-wave Observatory simultaneously observed a transient gravitational-wave',
      'signal. The signal sweeps upwards in frequency from 35 to 250 Hz with a peak',
      'gravitational-wave strain of 1.0e-21. It matches the waveform predicted by general',
      'relativity for the inspiral and merger of a pair of black holes and the ringdown of the',
      'resulting single black hole. The signal was observed with a matched-filter',
      'signal-to-noise ratio of 24 and a false alarm rate estimated to be less than 1 event per',
      '203 000 years, which corresponds to a significance greater than 5.1 sigma.',
      '',
      'I. INTRODUCTION',
      'The first direct detection of gravitational waves has long been regarded as one of the',
      'most important goals of modern physics. General relativity predicts that a system of two',
      'orbiting compact objects loses energy through the emission of gravitational radiation,',
      'causing the orbit to decay. For binary black holes this inspiral ends in a merger.',
    ]),
    page('II. DETECTORS', [
      'II. DETECTORS',
      'The LIGO detectors are Michelson interferometers with 4 km long arms. Each detector',
      'employs a power-recycled Fabry-Perot Michelson configuration. The strain sensitivity',
      'of the instrument is limited by seismic noise at low frequency, thermal noise in the',
      'mirror coatings at intermediate frequency, and photon shot noise at high frequency.',
      '',
      'III. SEARCH METHOD',
      'We use matched filtering against a bank of template waveforms. For a given template, the',
      'matched-filter signal-to-noise ratio is computed from the two detector data streams,',
      'coincidence is required within the 10 ms light travel time between the sites, and a',
      'chi-squared consistency test is applied to reject non-Gaussian transients.',
      '',
      'IV. RESULTS',
      'The reconstructed source parameters place the component masses at 36 and 29 solar',
      'masses and the final black hole mass at 62 solar masses, with 3 solar masses radiated',
      'as gravitational waves. The luminosity distance is estimated at 410 Mpc.',
    ]),
    page('V. DISCUSSION', [
      'V. DISCUSSION',
      'The detection is consistent with the general-relativistic prediction for a binary black',
      'hole coalescence. No evidence for deviations from general relativity was found in the',
      'accessible parameter space. The rate of such mergers is estimated to be between 2 and',
      '600 Gpc^-3 yr^-1 at 90% confidence.',
      '',
      'VI. CONCLUSION',
      'This observation confirms the existence of binary stellar-mass black hole systems and',
      'opens a new era of gravitational-wave astronomy. Future observing runs with improved',
      'sensitivity will increase the detection rate substantially.',
      '',
      'REFERENCES',
      '[1] A. Einstein, Sitzungsber. Preuss. Akad. Wiss. Berlin (1916).',
      '[2] C. M. Will, Living Rev. Relativ. 17, 4 (2014).',
    ]),
  ],
};

const paperB = {
  file: 'no-doi.pdf',
  meta: {
    title: 'A Lightweight Attention Mechanism for Low-Resource Text Classification',
    author: 'Jane Q. Doe, Wei Zhang, Aris Papadopoulos',
    subject: 'Preprint',
  },
  pages: [
    page('A Lightweight Attention Mechanism for Low-Resource Text Classification', [
      'Jane Q. Doe*, Wei Zhang, Aris Papadopoulos',
      'Institute for Computational Linguistics',
      '*corresponding author: jane.doe@example.edu',
      '',
      'Abstract',
      'We introduce SparseGated Attention, a parameter-efficient attention variant that reduces',
      'the quadratic cost of self-attention to near-linear while retaining most of its',
      'expressive power. On three low-resource classification benchmarks the method matches a',
      'full transformer baseline within 0.4 F1 points using 31% of the parameters.',
      '',
      '1 Introduction',
      'Transformer models dominate text classification, yet their memory footprint remains a',
      'barrier for deployment in low-resource settings. Prior work has explored sparsity,',
      'low-rank factorisation, and kernel approximations, each trading accuracy for efficiency.',
    ]),
    page('2 Method', [
      '2 Method',
      'Given an input sequence of embeddings, we compute a gating scalar per head and apply a',
      'top-k sparsification over the attention logits. The gate is trained jointly with the',
      'rest of the network using a straight-through estimator.',
      '',
      '3 Experiments',
      'We evaluate on three datasets with fewer than 5,000 training examples each. All models',
      'are trained for 30 epochs with AdamW and a linear warmup schedule.',
      '',
      '4 Results',
      'SparseGated Attention achieves 87.1 average F1 compared to 87.5 for the full baseline,',
      'while using 31% of the parameters and 44% of the inference FLOPs.',
    ]),
  ],
};

async function build(spec) {
  const doc = await PDFDocument.create();
  doc.setTitle(spec.meta.title);
  doc.setAuthor(spec.meta.author);
  doc.setSubject(spec.meta.subject);
  doc.setProducer('paper-reader test fixture');

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  for (const p of spec.pages) {
    const pg = doc.addPage([612, 792]);
    pg.drawText(p.title, { x: 60, y: 720, size: 17, font: bold, color: rgb(0, 0, 0), maxWidth: 492 });
    let y = 690;
    for (const line of p.lines) {
      if (line) {
        const isHeading = /^([IVX]+\.|\d\s|\d\.|ABSTRACT|Abstract|REFERENCES)/.test(line);
        pg.drawText(line, {
          x: 60,
          y,
          size: isHeading ? 11.5 : 10.5,
          font: isHeading ? bold : font,
          color: rgb(0, 0, 0),
          maxWidth: 492,
        });
      }
      y -= 15.5;
    }
  }
  const bytes = await doc.save();
  const target = path.join(outDir, spec.file);
  fs.writeFileSync(target, bytes);
  console.log('wrote', target, bytes.length, 'bytes,', spec.pages.length, 'pages');
}

await build(paperA);
await build(paperB);
