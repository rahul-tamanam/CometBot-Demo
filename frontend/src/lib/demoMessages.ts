/**
 * Demo / legal copy for portfolio deployment.
 * Not legal advice — have counsel review if you commercialize beyond a student portfolio.
 */

export const DEMO_ACK_STORAGE_KEY = 'cometbot_demo_ack_v1'

export const DEMO_DISCLAIMER_SHORT =
  'Portfolio demo only · Not official UT Dallas advising'

export const DEMO_MODAL_TITLE = 'Portfolio demonstration notice'

export const DEMO_MODAL_INTRO =
  'You are using CometBot as a personal portfolio project. Please read this notice before continuing.'

/** Shown in modal and footer — structured for scannability */
export const DEMO_LEGAL_SECTIONS: { heading: string; body: string }[] = [
  {
    heading: 'Not official advising',
    body:
      'CometBot is an independent demonstration built for academic/portfolio purposes. It is not operated by, affiliated with, or endorsed by The University of Texas at Dallas (UT Dallas), the Naveen Jindal School of Management, or any official advising office.',
  },
  {
    heading: 'Recommendations are project outputs only',
    body:
      'All course suggestions, degree progress summaries, career paths, certificate ideas, and skills-gap analyses are generated from data and rules collected for this project (catalog JSON, program rules, retrieval indexes, and AI models). They are illustrative examples—not verified graduation checks, official degree audits, or employment advice.',
  },
  {
    heading: 'No liability',
    body:
      'The creator(s) of this demo and any hosting provider make no warranties about accuracy, completeness, or fitness for a particular purpose. You agree that use of this site is at your own risk. To the fullest extent permitted by law, no party involved in building or hosting this demo shall be liable for any decision, loss, or outcome you base on information shown here.',
  },
  {
    heading: 'Do not submit sensitive data',
    body:
      'Do not enter real passwords, Social Security numbers, financial data, or full official transcripts with personal identifiers. Use sample or redacted information only. Data you enter may be processed by third-party APIs (e.g. Groq) under their terms.',
  },
  {
    heading: 'Verify with official sources',
    body:
      'Always confirm requirements with UT Dallas catalog, your academic advisor, and official university systems before enrolling in courses or making academic or career decisions.',
  },
]

export const DEMO_MODAL_CHECKBOX_LABEL =
  'I understand this is a non-official portfolio demo. Recommendations are for demonstration only and no one is liable for decisions I make based on this tool.'

export const DEMO_DISCLAIMER =
  'CometBot is a portfolio demo only—not affiliated with or endorsed by UT Dallas. ' +
  'Recommendations reflect project data and AI outputs for illustration only, not official advising. ' +
  'Use at your own risk; verify all academic decisions with the university.'

export const degreePlannerNetworkFallback =
  'This demo could not reach the server. Degree planning text is unavailable right now. ' +
  'Check your connection and refresh, or try again later.'

export const careerMentorNetworkFallback =
  'This demo could not reach the server. Career mentor text is unavailable right now. ' +
  'Check your connection and refresh, or try again later.'

export const skillsGapNetworkFallback =
  'This demo could not reach the server. Skills gap analysis is unavailable right now. ' +
  'Check your connection and refresh, or try again later.'

export const transcriptNetworkFallback =
  'Transcript upload is unavailable in this demo session. Continue by selecting your program ' +
  'and adding courses manually.'

export const catalogNetworkFallback =
  'The course catalog is temporarily unavailable. You can still type course IDs manually ' +
  '(e.g. BUAN 6341).'
