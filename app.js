'use strict'

import * as Misskey from 'misskey-js';
import { Octokit } from '@octokit/rest';

const spiltCommentsCheckAttemptsMaximum = process.env.DRY_RUN === 'true' ? 1 : 5;

async function run() {
  let comments = null
  let attempt = 0

  while (true) {
    comments = await getComments()
    if (comments.length === 0) break
    await post(comments)

    attempt++
    if (process.env.DRY_RUN === 'true') {
      console.info('The action is supposed to be performed until all the comments are transferred, but it is done only once because dry run is enabled.')
      process.exit(0)
    }
    else if (attempt >= spiltCommentsCheckAttemptsMaximum) {
      console.error(`The action was run ${attempt} times, but the comments still exist.`)
      process.exit(1)
    }
  }
}

async function getComments() {
  const api = setupAPI()
  let comments = []
  let page = 1
  const perPage = 100
  let response = null

  do {
    response = await api.octokit.issues.listComments({
      owner: api.owner,
      repo: api.repo,
      issue_number: process.env.ISSUE_NUMBER,
      page,
      per_page: perPage
    })

    comments = comments.concat(response.data)
    page++
  } while (response.data.length === perPage)

  return comments
}

async function post(comments) {
  for (let comment of comments) {
    try {
      await createNote(comment.body);
      await deleteComment(comment.id);
    }
    catch (error) {
      console.log('here!')
      console.error(error);
      process.exit(1);
    }
  }
}

async function createNote(commentBody) {
  if (process.env.DRY_RUN === 'true') {
    console.info(`The comment "${commentBody.split(/[\r\n|\r|\n]/)[0]}" is supposed to be posted, but not done because dry run is enabled.`);
    return true;
  }

  const note = await setupAPI().misskey.request(
    'notes/create',
    {
      visibility: 'public', // TODO: add ability to specify this with a specific expression in the comment
      cw: null,             // TODO: add ability to specify this with a specific expression in the comment
      text: commentBody,
      not: 'found'
    }
  );

  return note;
}

async function deleteComment(commentID) {
  const api = setupAPI()

  if (process.env.DRY_RUN === 'true') {
    console.info(`The comment "${commentID}" is supposed to be deleted, but not done because dry run is enabled.`);
    return true;
  }

  await setupAPI().octokit.issues.deleteComment({
    owner: api.owner,
    repo: api.repo,
    comment_id: commentID,
  })
}

function setupAPI() {
  const octokit = process.env.PERSONAL_ACCESS_TOKEN ?
                  new Octokit({ auth: process.env[process.env.PERSONAL_ACCESS_TOKEN] }) :
                  new Octokit({ auth: process.env.GITHUB_TOKEN })
  const repository = process.env.GITHUB_REPOSITORY
  const [ owner, repo ] = repository.split('/')

  const misskey = new Misskey.api.APIClient({
    origin: `https://${process.env.MISSKEY_SERVER}`,
    credential: process.env.MISSKEY_API_TOKEN
  });

  return {
    octokit: octokit,
    owner: owner,
    repo: repo,
    misskey: misskey
  }
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
