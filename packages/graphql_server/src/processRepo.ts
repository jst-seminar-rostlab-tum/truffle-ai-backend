import supabase from './supabase'
import {
  getOrganizationID,
  getGithubData,
  getPersonID,
  turnIntoProjectInsertion,
  getProjectID
} from './dataAggregation'
import { OrganizationUpdate, ProjectInsertion, ProjectUpdate } from '../types/dataAggregation'
import { GitHubInfo, ProjectFounder } from '../types/githubApi'
import { getRepoStarRecords } from './starHistory/starHistory'
import { StarRecord } from '../types/starHistory'
import { TrendingState } from '../types/processRepo'
import { fetchRepositoryReadme } from './scraping/githubScraping'
import { getELI5FromReadMe, getHackernewsSentiment } from './api/openAIApi'
import { repoIsAlreadyInDB } from './dbUpdater'
import { searchHackerNewsStories } from './scraping/hackerNewsScraping'
import { getCompanyInfosFromLinkedIn } from './scraping/linkedInScraping'
import { LinkedInCompanyProfile } from '../types/linkedInScraping'
import { getRepoFounders } from './api/githubApi'

/**
 * Adds a repo to the database.
 * This method should only be called when it is certain that a repo is not in the database yet.
 * @param {string} name - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 * @returns {boolean} True if the repo was added to the database.
 */
export const insertProject = async (name: string, owner: string, trendingState: TrendingState) => {
  // hacky solution for now. Only if the trendingState is null is it needed to check if
  // the repo is already in the database, because right now when this function is called with a trending state
  // then that call comes from dbUpdater.ts and there it is already checked if the repo is in the database
  if (!trendingState && (await repoIsAlreadyInDB(name, owner))) {
    return false
  }
  // get the github data
  const githubData: GitHubInfo | null = await getGithubData(name, owner)
  if (!githubData) return false
  // get the starHistory
  const starHistory: StarRecord[] = await getRepoStarRecords(
    owner + '/' + name,
    process.env.GITHUB_API_TOKEN,
    25
  )
  // convert the github data into a format that can be inserted into the database
  const projectInsertion: ProjectInsertion = turnIntoProjectInsertion(githubData, starHistory)

  projectInsertion.owning_organization = await getOrganizationID(owner)
  projectInsertion.owning_person = await getPersonID(owner)
  if (trendingState) {
    projectInsertion[trendingState] = true
  }

  // insert the repo into the database
  const { error: insertionError } = await supabase.from('project').insert([projectInsertion])

  if (!insertionError) {
    // if it got inserted, then add the other data sources
    await updateProjectSentiment(name, owner)
    await updateProjectELI5(name, owner)
    console.log('Inserted ', name, 'owned by', owner)
    return true
  }

  console.log('Error while inserting ', name, 'owned by', owner, ' \n Error: \n ', insertionError)
  return false
}

/**
 * Updates a repo that is currently in the db.
 * Ath the moment this method only updates the github stats and star history.
 * In the future it will update gh stats + twitter on a daily and everything else on a weekly basis
 * @param {string} name - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 */
export const updateProject = async (name: string, owner: string) => {
  // get the github data
  const githubData: GitHubInfo | null = await getGithubData(name, owner)
  if (!githubData) return null
  // get the starHistory
  const starHistory: StarRecord[] = await getRepoStarRecords(
    owner + '/' + name,
    process.env.GITHUB_API_TOKEN,
    25
  )
  // convert the github data into a format that can be inserted into the database. ProjectUpdate and ProjectInsertion are virtually  the same
  const projectUpdate: ProjectUpdate = turnIntoProjectInsertion(
    githubData,
    starHistory
  ) as ProjectUpdate

  const updated = await updateSupabaseProject(name, owner, projectUpdate)

  updated ? console.log('updated ', name, 'owned by', owner) : null
}

/**
 * Updates the trending state of a repo
 * @param {string} name - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 * @param {string} trendingState - The trending state that should be set to true
 */
export const updateProjectTrendingState = async (
  name: string,
  owner: string,
  trendingState: TrendingState
) => {
  const projectUpdate: ProjectUpdate = {}
  if (trendingState) {
    projectUpdate[trendingState] = true
  }

  const updated = await updateSupabaseProject(name, owner, projectUpdate)
  updated ? console.log('updated trending state of ', name, ' to ', trendingState) : null
}

/**
 * Updates the supabase entry of a repo
 * @param {string} name - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 * @param {ProjectUpdate} updatedProject - The Changes that should be put on supabase
 * @returns {boolean} - Whether the update was successful
 */
export const updateSupabaseProject = async (
  name: string,
  owner: string,
  updatedProject: ProjectUpdate
) => {
  //check whether the repo is in the db
  if (!(await repoIsAlreadyInDB(name, owner))) {
    return false
  }
  const owningOrganizationID = await getOrganizationID(owner)

  const { error: ownerUpdateError } = await supabase
    .from('project')
    .update(updatedProject)
    .eq('name', name)
    .eq('owning_organization', owningOrganizationID)

  if (!ownerUpdateError) return true
  const owningPersonID = await getPersonID(owner)
  const { error: ownerUpdateError2 } = await supabase
    .from('project')
    .update(updatedProject)
    .eq('name', name)
    .eq('owning_person', owningPersonID)

  return ownerUpdateError2 ? false : true
}

/**
 * Updates the eli5 of a repo
 * @param {string} name - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 */
export const updateProjectELI5 = async (name: string, owner: string) => {
  try {
    const readMe = (await fetchRepositoryReadme(owner, name)).slice(0, 2500)
    const description = await getELI5FromReadMe(readMe)
    const updated = await updateSupabaseProject(name, owner, { eli5: description })
    updated && console.log('updated eli5 of ', name, 'owned by', owner)
  } catch (e) {
    console.error('Error while fetching readme for ', name, 'owned by', owner)
    await updateSupabaseProject(name, owner, {
      eli5: 'ELI5/description could not be generated for this project'
    })
  }
}

/**
 * Updates the HNsentiment and the corresponding links towards a repo
 * @param {string} repoName - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 */
export const updateProjectSentiment = async (repoName: string, owner: string) => {
  let allComments = ''
  const allLinks: string[] = []

  let currentStory = await searchHackerNewsStories(owner + '/' + repoName)
  if (currentStory) {
    allComments += '\n Next group of comments: \n' + currentStory.comments.join('\n')
    allLinks.push(...currentStory.linksToPosts)
  }

  currentStory = await searchHackerNewsStories(repoName)
  if (currentStory) {
    allComments += '\n Next group of comments: \n' + currentStory.comments.join('\n')
    allLinks.push(...currentStory.linksToPosts)
  }

  if (!allComments) {
    console.log('No comments found for ', repoName, 'owned by', owner)
    return
  }

  const sentimentSummary = await getHackernewsSentiment(allComments)
  if (
    await updateSupabaseProject(repoName, owner, {
      hackernews_sentiment: sentimentSummary,
      hackernews_stories: allLinks
    })
  ) {
    console.log('updated sentiment for ', repoName, 'owned by', owner)
  } else {
    console.log('Error while updating sentiment for ', repoName, 'owned by', owner)
  }
}

/**
 * Updates all columns of organization that are populated with data that come from linkedIN
 * @param {string} organizationHandle - The login of the organization.
 */
export const updateProjectLinkedInData = async (organizationHandle: string) => {
  // check if repo is owned by an organization
  const { data: supabaseOrga } = await supabase
    .from('organization')
    .select('id, linkedin_url')
    .eq('login', organizationHandle)
  // if owning_organization is null then the project is owned by an user and no linkedIn data is fetched
  // if the linkedIn url is not null then this means that the linkedIn data was already fetched
  // we need to save API tokens so we don't want to fetch the data again
  if (!supabaseOrga || supabaseOrga?.[0].linkedin_url) {
    return false
  }

  // otherwise get the linkedIn data
  // please leave the console.log for now. We have to be super cautious with API tokens and I
  // want to see whenever this function is called
  console.log('Fetching linlkedIn data for organization', organizationHandle, '...')
  const linkedinData = await getCompanyInfosFromLinkedIn(organizationHandle)
  if (!linkedinData?.name) {
    console.log('No linkedIn data found for organization', organizationHandle)
    return false
  }

  // insert the formatted info
  const { error: updateError } = await supabase
    .from('organization')
    .update(formatLinkedInCompanyData(linkedinData))
    .eq('login', organizationHandle)

  // if no error occured the insert was successful
  console.log('Updated linkedIn data for ', organizationHandle)
  return !updateError
}

/**
 * Updates the founders of a repo. That means that it inserts the founders into the db if they are not already there
 * Actually the founders will not change over time with how we get them right now (first committers)
 * @param {string} repoName - The name of the repo.
 * @param {string} owner - The name of the owner of the repo.
 */
export const updateProjectFounders = async (repoName: string, owner: string) => {
  const founders: ProjectFounder[] = await getRepoFounders(owner, repoName)
  const projectID: string | null = await getProjectID(repoName, owner)

  //if the projectID is falsy return
  if (!projectID) {
    return
  }

  for (const founder of founders) {
    const founderID: string | null = await getPersonID(founder.login)
    if (!founderID) {
      // getPersonID inserts the user if they don't exist yet,
      // so founderID being null means that the user is not on the db and was not inserted
      continue
    }
    const { data: alreadyExists } = await supabase
      .from('founded_by')
      .select()
      .eq('founder_id', founderID)
      .eq('project_id', projectID)

    if (alreadyExists?.[0]) {
      continue
    }

    const { error: insertError } = await supabase
      .from('founded_by')
      .insert({ founder_id: founderID, project_id: projectID })

    !insertError
      ? console.log('Added', founder.login, 'as founder for', repoName, 'owned by', owner)
      : console.log(
          'Error while adding',
          founder.login,
          'as founder for',
          repoName,
          'owned by',
          owner
        )
  }
}

/**
 * This function should be put somewhere else later on. Credits to chatGPT for creating it
 * Parses a GitHub URL and extracts the repository name and owner.
 * @param {string} url - The GitHub URL.
 * @returns {{name: string, owner: string} | null} An object containing the owner and repo names, or null if the URL is invalid.
 */
export const parseGitHubUrl = (url: string) => {
  const pattern = /https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/[\w.-]+)*$/
  const match = pattern.exec(url)

  if (match && match.length === 3) {
    const [, owner, repo] = match
    return { owner, repo }
  }

  return null
}

/**
 * Formats the linkedInData to the format that is used in the db
 * @param {LinkedInCompanyProfile} linkedInData - The companny linkedIn data
 */
const formatLinkedInCompanyData = (linkedInData: LinkedInCompanyProfile): OrganizationUpdate => {
  return {
    crunchbase: linkedInData.crunchbaseUrl,
    founded: parseInt(linkedInData.founded, 10),
    hq_location: linkedInData.hqLocation,
    industries: linkedInData.industries,
    linkedin_about: linkedInData.about,
    linkedin_followers: linkedInData.followers,
    linkedin_updates: linkedInData.updates,
    linkedin_url: linkedInData.url,
    linkedin_website_url: linkedInData.website,
    number_of_employees: parseInt(linkedInData.employeesAmountInLinkedin),
    specialties: linkedInData.specialties
  }
}
