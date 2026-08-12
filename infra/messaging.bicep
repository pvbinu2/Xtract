targetScope = 'resourceGroup'

@description('Globally unique Service Bus namespace name.')
param serviceBusNamespaceName string

@description('Name of the existing storage account in this resource group.')
param storageAccountName string

@description('Principal ID of the API managed identity.')
param apiPrincipalId string

@description('Principal ID of the Function App managed identity.')
param functionPrincipalId string

param location string = resourceGroup().location
param triggerContainerName string = 'trigger'
param deadLetterContainerName string = 'eventgrid-deadletter'

var queueNames = [
  'blob-ingestion'
  'document-processing'
  'document-classification'
  'document-extraction'
  'classifier-training'
  'document-events'
]
var serviceBusSenderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39')
var serviceBusReceiverRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '090c5cfd-751d-490a-894a-3ce6f1109419')
var storageBlobContributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = {
  parent: storage
  name: 'default'
}

resource deadLetterContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: deadLetterContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource serviceBus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: serviceBusNamespaceName
  location: location
  sku: {
    name: 'Premium'
    tier: 'Premium'
    capacity: 1
  }
  properties: {
    disableLocalAuth: true
    minimumTlsVersion: '1.2'
    zoneRedundant: false
  }
}

resource queues 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = [for queueName in queueNames: {
  parent: serviceBus
  name: queueName
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    defaultMessageTimeToLive: 'P14D'
    deadLetteringOnMessageExpiration: true
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    requiresSession: false
  }
}]

resource apiSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, apiPrincipalId, serviceBusSenderRoleId)
  scope: serviceBus
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: serviceBusSenderRoleId
  }
}

resource functionSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, functionPrincipalId, serviceBusSenderRoleId)
  scope: serviceBus
  properties: {
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: serviceBusSenderRoleId
  }
}

resource functionReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, functionPrincipalId, serviceBusReceiverRoleId)
  scope: serviceBus
  properties: {
    principalId: functionPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: serviceBusReceiverRoleId
  }
}

resource storageEvents 'Microsoft.EventGrid/systemTopics@2023-12-15-preview' = {
  name: '${storageAccountName}-blob-events'
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    source: storage.id
    topicType: 'Microsoft.Storage.StorageAccounts'
  }
}

resource eventGridSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(serviceBus.id, storageEvents.id, serviceBusSenderRoleId)
  scope: serviceBus
  properties: {
    principalId: storageEvents.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: serviceBusSenderRoleId
  }
}

resource eventGridDeadLetterWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(deadLetterContainer.id, storageEvents.id, storageBlobContributorRoleId)
  scope: deadLetterContainer
  properties: {
    principalId: storageEvents.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: storageBlobContributorRoleId
  }
}

resource blobCreatedSubscription 'Microsoft.EventGrid/systemTopics/eventSubscriptions@2023-12-15-preview' = {
  parent: storageEvents
  name: 'xtract-blob-created'
  properties: {
    eventDeliverySchema: 'EventGridSchema'
    deliveryWithResourceIdentity: {
      identity: {
        type: 'SystemAssigned'
      }
      destination: {
        endpointType: 'ServiceBusQueue'
        properties: {
          resourceId: queues[0].id
        }
      }
    }
    deadLetterWithResourceIdentity: {
      identity: {
        type: 'SystemAssigned'
      }
      deadLetterDestination: {
        endpointType: 'StorageBlob'
        properties: {
          resourceId: storage.id
          blobContainerName: deadLetterContainer.name
        }
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.Storage.BlobCreated'
      ]
      subjectBeginsWith: '/blobServices/default/containers/${triggerContainerName}/blobs/'
      isSubjectCaseSensitive: false
      advancedFilters: [
        {
          operatorType: 'StringIn'
          key: 'data.api'
          values: [
            'PutBlob'
            'PutBlockList'
            'FlushWithClose'
          ]
        }
      ]
    }
    retryPolicy: {
      maxDeliveryAttempts: 30
      eventTimeToLiveInMinutes: 1440
    }
  }
  dependsOn: [
    eventGridSender
    eventGridDeadLetterWriter
  ]
}

output serviceBusFullyQualifiedNamespace string = '${serviceBus.name}.servicebus.windows.net'
output functionServiceBusSettingName string = 'ServiceBusConnection__fullyQualifiedNamespace'
output apiServiceBusSettingName string = 'SERVICE_BUS_FULLY_QUALIFIED_NAMESPACE'
