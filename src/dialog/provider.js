import path from 'path'
import fs from 'fs'
import glob from 'glob'
import _ from 'lodash'
import Promise from 'bluebird'
import EventEmitter2 from 'eventemitter2'
import mkdirp from 'mkdirp'

import { validateFlowSchema } from './validator'

export default class FlowProvider extends EventEmitter2 {
  constructor({ logger, botfile, projectLocation, ghostManager }) {
    super({
      wildcard: true,
      maxListeners: 100
    })

    this.logger = logger
    this.botfile = botfile
    this.projectLocation = projectLocation
    this.ghostManager = ghostManager
  }

  async loadAll() {
    const relDir = this.botfile.flowsDir || './flows'
    const flowFiles = await this.ghostManager.directoryListing(relDir, '.flow.json')

    const flows = await Promise.all(
      flowFiles.map(async name => {
        const uiFileName = name.replace(/\.flow/g, '.ui')
        const flow = JSON.parse(await this.ghostManager.readFile(relDir, name))

        const schemaError = validateFlowSchema(flow)
        if (!flow || schemaError) {
          return flow ? this.logger.warn(schemaError) : null
        }

        const uiEq = JSON.parse(await this.ghostManager.readFile(relDir, uiFileName))

        Object.assign(flow, { links: uiEq.links })

        // TODO: refactor to separate function
        // Take position from UI files or create default position
        const unplacedNodes = []
        flow.nodes.forEach(node => {
          const uiNode = _.find(uiEq.nodes, { id: node.id }) || {}

          Object.assign(node, uiNode.position)

          if (_.isNil(node.x) || _.isNil(node.y)) {
            unplacedNodes.push(node)
          }
        })

        const unplacedY = (_.maxBy(flow.nodes, 'y') || { y: 0 }).y + 250
        let unplacedX = 50

        unplacedNodes.forEach(node => {
          node.y = unplacedY
          node.x = unplacedX
          unplacedX += 250
        })

        return {
          name,
          location: name,
          nodes: _.filter(flow.nodes, node => !!node),
          ..._.pick(flow, 'version', 'catchAll', 'startNode', 'links', 'skillData')
        }
      })
    )

    return flows.filter(flow => Boolean(flow))
  }

  async saveFlows(flows) {
    const flowsToSave = await Promise.mapSeries(flows, flow => this._prepareSaveFlow(flow))

    const flowsDir = this.botfile.flowsDir || './flows'
    mkdirp.sync(path.dirname(flowsDir))
    await this.ghostManager.addRootFolder(flowsDir, '**/*.json')

    for (const { flowPath, uiPath, flowContent, uiContent } of flowsToSave) {
      if (flowPath.includes('/')) {
        mkdirp.sync(path.dirname(flowPath))
      }

      fs.writeFileSync(flowPath, JSON.stringify(flowContent, null, 2))
      fs.writeFileSync(uiPath, JSON.stringify(uiContent, null, 2))

      const flowFileName = flowPath.split('/')[flowPath.split('/').length - 1]
      const uiFileName = uiPath.split('/')[uiPath.split('/').length - 1]
      this.ghostManager.recordRevision(flowsDir, flowFileName, JSON.stringify(flowContent, null, 2))
      this.ghostManager.recordRevision(flowsDir, uiFileName, JSON.stringify(uiContent, null, 2))
    }

    const searchOptions = { cwd: path.resolve(this.projectLocation, flowsDir) }
    const flowFiles = await this.ghostManager.directoryListing(flowsDir, '.flow.json')

    flowFiles
      .map(fileName => [fileName, path.resolve(this.projectLocation, flowsDir, './' + fileName)])
      .filter(([, filePath]) => !flowsToSave.find(flow => flow.flowPath === filePath || flow.uiPath === filePath))
      .map(([fileName, filePath]) => {
        fs.unlinkSync(filePath)
        this.ghostManager.recordRevision(flowsDir, fileName, null)
      })

    this.emit('flowsChanged')
  }

  async _prepareSaveFlow(flow) {
    flow = Object.assign({}, flow, {
      version: '0.1'
    })

    const schemaError = validateFlowSchema(flow)
    if (schemaError) {
      throw new Error(schemaError)
    }

    // What goes in the ui.json file
    const uiContent = {
      nodes: flow.nodes.map(node => ({
        id: node.id,
        position: { x: node.x, y: node.y }
      })),
      links: flow.links
    }

    // What goes in the .flow.json file
    const flowContent = {
      version: flow.version,
      startNode: flow.startNode,
      catchAll: flow.catchAll,
      nodes: flow.nodes,
      skillData: flow.skillData
    }

    flowContent.nodes.forEach(node => {
      // We remove properties that don't belong in the .flow.json file
      delete node['x']
      delete node['y']
      delete node['lastModified']
    })

    const relDir = this.botfile.flowsDir || './flows'
    const flowPath = path.resolve(this.projectLocation, relDir, './' + flow.location)
    const uiPath = flowPath.replace(/\.flow\.json/i, '.ui.json')

    return { flowPath, uiPath, flowContent, uiContent }
  }
}
