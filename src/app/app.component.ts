import { trigger, state, style, transition, animate, AnimationFactory, AnimationBuilder, AnimationPlayer } from '@angular/animations';
import { AfterViewInit, Component, DoCheck, ElementRef, EventEmitter, Input, NgZone, OnChanges, OnDestroy, OnInit, Output, QueryList, Renderer2, SimpleChanges, TemplateRef, ViewChild, ViewChildren, ViewContainerRef } from '@angular/core';
import { AbstractControl, FormArray, FormBuilder, FormGroup } from '@angular/forms';
import { MatDatepicker, MatTable } from '@angular/material';
import { AuthenticationService, EntityListService, IDropdownGetDataEvent, IListItem, NumericInputDirective, UtilityService } from '@ntk/common-controls';
import { BehaviorSubject, fromEvent, merge, Observable, of, pipe, Subject, Subscription } from 'rxjs';
import { map, mergeMap, startWith, switchMap, take, takeUntil, tap } from 'rxjs/operators';
import { IJob } from 'src/app/shared/model/common.model';
import { AssignmentStatus, IIntervention, IInterventionAssignments } from '../../shared/interventions.model';
import { InterventionsService } from '../../shared/interventions.service';

@Component({
  selector: 'gfm-edit-assignments',
  templateUrl: './edit-assignments.component.html',
  styleUrls: ['./edit-assignments.component.scss'],
  animations: [
    trigger('detailExpand', [
      state('collapsed', style({ height: '0px', minHeight: '0' })),
      state('expanded', style({ height: '*' })),
      transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
    ]),
  ],
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit, OnChanges {
  @ViewChild('workloadField', { static: false }) _workloadField: NumericInputDirective;
  @ViewChild('action', { static: false }) action: ElementRef;
  @ViewChildren('elementRow', { read: ElementRef }) private elementRow!: QueryList<ElementRef>;
  @Input() data: IInterventionAssignments[];
  @Input() resource;
  @Input() requestedResource;
  @Input() resourceCompany;
  @Input() site;
  @Input() job;
  @Input() project: IListItem;
  @Input() showHistoryButtons;
  @Output() openHistoryDialog = new EventEmitter<any>();
  displayedColumns: string[] = ['PlannedDate&Resource', 'PlannedStartTime&PlannedEndTime'];
  dataSource = new BehaviorSubject<AbstractControl[]>([]);
  advancedInterventionPlanning: boolean;
  allStatus = [
    AssignmentStatus[AssignmentStatus.Planned],
    AssignmentStatus[AssignmentStatus.InProgress],
    AssignmentStatus[AssignmentStatus.Completed],
    AssignmentStatus[AssignmentStatus.Cancelled],
    AssignmentStatus[AssignmentStatus.Draft]
  ];
  canAddNew = true;
  expandedElement: IInterventionAssignments
  private isJobInValid: boolean;
  private isFirstChangeCompany = true; // using for detect the first time intervener company patchValue
  private _deletedIds: string[] = [];
  private _whiddenEl: number = 100; // 40x2 + 10x2 : wbtn x2 + padding left + padding right
  assignmentsForm: FormArray;
  formGroups: FormGroup;
  isManagedCompany: boolean;
  formArrayValueChanges$ = new Subscription();
  private subWatchChange = new Subject<any>();
  private managedCompanyId: string;
  private player!: AnimationPlayer;
  constructor(
    private fb: FormBuilder,
    private _listService: EntityListService,
    private _utilityService: UtilityService,
    private builder: AnimationBuilder,
    private zone: NgZone,
    private _authService: AuthenticationService) {
    this.managedCompanyId = this._authService.currentManagedCompany.Id;
    this.advancedInterventionPlanning = this._authService.getParameterValue('AdvancedInterventionPlanning');
    if (!this.data || this.data.length === 0) {
      // auto add one row when assignment is null
      // Case assignments = null can come form resource planning once user delete all assignments
      this.data = [];
      this.data.push(
        {
          Id: '00000000-0000-0000-0000-000000000000',
          PlannedDate: null,
          PlannedWorkload: null,
          PlannedStartTime: null,
          PlannedEndTime: null,
          Resource: this.resource,
          ResourceCompany: this.resourceCompany,
          Status: AssignmentStatus.Draft
        }
      );
    }
  }

  ngOnInit() {
    this.initFormGroup();
    this.formArrayValueChanges$ = this.assignmentsForm.valueChanges.subscribe(() => {
      this.findFieldChanged();
    });
    // purpose: change when remove one assignment
    // Comparing with data saved in DB not in UI
    if (this.data) {
      // this.assignmentsForm.patchValue([], { emitEvent: true });
      this.assignmentsForm.patchValue(this.data, { emitEvent: true });
      this.assignmentsForm.controls.forEach((i, index) => {
        i.get('InitStatus').patchValue(this.data[index].Status);
      });
      this.data.forEach((x, i) => {
        this.disableStatusField({ index: i });
      })
    }
    this.updateView();
  }

  ngAfterViewInit(): void {
    if (this._workloadField) { this._workloadField.formatDisplayValue(); }
    this.mouseDownUpCoordinates();
    this.elementRow.changes.subscribe(() => {
      this.mouseDownUpCoordinates();
    });
  }

  ngOnChanges(changes: SimpleChanges) {
    for (const propName in changes) {
      if (changes.hasOwnProperty(propName)) {
        /**
         * If Job invalid, don't care about change of resourceCompany
         * When Job change state valid <=>invalid, re-check form with curren resouceCompany many changed before
         */
        switch (propName) {
          case 'resourceCompany': {
            // detect first change, only the first change we need to show status colum for internal company
            if ((changes[propName].currentValue && changes[propName].previousValue) || (changes[propName].previousValue && changes[propName].currentValue)) {
              this.isFirstChangeCompany = false;
            }
            this.isManagedCompany = this.resourceCompany && this.resourceCompany.Id === this.managedCompanyId;
            this.isJobInValid = this.job && (this.job.IsClosedForOperations || (this.job.IsBlockedForTimesheets && this.isManagedCompany));
            if (!this.isJobInValid) {
              this.onChangeResourceCompany();
              setTimeout(() => {
                if (this.assignmentsForm && this.assignmentsForm.controls[0].get('PlannedDate').disabled) {
                  this.formGroups.enable({ emitEvent: false });
                  this.assignmentsForm.controls.forEach((c, index) => {
                    this.disableStatusField({ index: index });
                  });
                  this.canAddNew = true;
                }
              }, 500);
            } else {
              if (this.isFirstChangeCompany) {
                this.onChangeResourceCompany();
              }
              this.onChangeJob();
            }
            break;
          }
          case 'job': {
            const currentValue = changes[propName].currentValue as IJob;
            const previousValue = changes[propName].previousValue as IJob;
            if (!(previousValue && currentValue && currentValue.Id === previousValue.Id)) { // job really change, bypass bug when import data from history
              this.onChangeJob();
            }
            break;
          }
        }
      }
    }
  }

  onChangeResourceCompany() {
    if (this.advancedInterventionPlanning) {
      if (this.isManagedCompany) {
        if (this.displayedColumns.findIndex(c => c === 'Status') === -1) {
          this.displayedColumns.splice(this.displayedColumns.findIndex(c => c === 'PlannedStartTime&PlannedEndTime') + 1, 0, 'Status');
        }
      } else {
        if (this.displayedColumns.findIndex(c => c === 'Status') !== -1) {
          this.displayedColumns.splice(this.displayedColumns.findIndex(c => c === 'Status'), 1);
        }
      }
      if (this.displayedColumns.findIndex(c => c === 'Action') === -1) {
        this.displayedColumns.push('Action');
      }
    }
  }

  onChangeJob() {
    // Job impact to assignment only is job is closed and blocked (with internal compnay)
    if (this.isJobInValid !== (this.job && (this.job.IsClosedForOperations || (this.job.IsBlockedForTimesheets && this.isManagedCompany)))) {
      this.isJobInValid = this.job && (this.job.IsClosedForOperations || (this.job.IsBlockedForTimesheets && this.isManagedCompany));
      if (!this.isJobInValid) {
        // re-compute assignment according to intervener company if job change from invalid to vaild
        this.onChangeResourceCompany();
      }
    }
    if (this.isJobInValid) {
      this.canAddNew = false;
      this.formGroups.disable({ emitEvent: false });
    } else {
      if (this.assignmentsForm && this.assignmentsForm.controls[0].get('PlannedDate').disabled) {
        this.formGroups.enable({ emitEvent: false });
        this.assignmentsForm.controls.forEach((c, index) => {
          this.disableStatusField({ index: index });
        });
      }
      this.canAddNew = true;
    }
  }

  // only patch value when change intervener company, not patch value when init form
  updateResourceCompany(event) {
    if (event && event.Id === this.managedCompanyId) {
      (this.formGroups.get('assignmentsForm') as FormArray).controls.forEach(control => {
        control.get('Resource').patchValue(event.DefaultIntervener);
      });
    } else {
      (this.formGroups.get('assignmentsForm') as FormArray).controls.forEach(control => {
        control.get('Resource').patchValue(null);
        control.get('CountOfInterventions').patchValue(null);
      });
    }
  }

  ngOnDestroy() {
    this.formArrayValueChanges$.unsubscribe();
  }

  updateView() {
    this.dataSource.next((this.formGroups.get('assignmentsForm') as FormArray).controls);
  }


  public initFormGroup() {
    this.assignmentsForm = this.fb.array(this.getAssignmentsForm()
      .map(assignment => this.fb.group(assignment, { validators: [this.endTimeValidator()] })));

    this.formGroups = this.fb.group({
      assignmentsForm: this.assignmentsForm
    });
  }

  // Maybe use in the future
  isEmptyData(): boolean {
    if (this.data.length === 1
      && (this.data[0].PlannedDate
        || this.data[0].PlannedStartTime
        || this.data[0].PlannedDate
        || this.data[0].PlannedWorkload
        || (this.data[0].Resource && this.isManagedCompany))
      || this.data.length > 1
      || (this.assignmentsForm && this.assignmentsForm.length > 1)) {
      return false;
    } else {
      return true;
    }
  }

  getAssignmentsForm(): any[] {
    const assignmentsForm = [];
    let count = this.data ? this.data.length : 0;
    for (let i = 0; i < count; i++) {
      assignmentsForm.push(this.createAssignment());
    }
    return assignmentsForm;
  }

  private createAssignment(disabled?: boolean): any {
    return {
      Id: ['00000000-0000-0000-0000-000000000000'],
      PlannedDate: [{ value: null, disabled }],
      PlannedWorkload: [{ value: null, disabled }],
      PlannedStartTime: [{ value: null, disabled }],
      PlannedEndTime: [{ value: null, disabled }],
      Resource: [{ value: null, disabled }],
      ResourceCompany: [{ value: null, disabled }],
      CountOfInterventions: [{ value: null, disabled: true }],
      Status: [{ value: AssignmentStatus.Draft, disabled: true }],
      InitStatus: [{ value: null, disabled: true }],
    };
  }

  endTimeValidator(): any {
    return (group: FormGroup) => {
      const plannedStartTime = group.get('PlannedStartTime').value;
      const plannedEndTime = group.get('PlannedEndTime').value;
      if (!this.timeRangeValid(plannedStartTime, plannedEndTime)) {
        group.get('PlannedStartTime').markAsTouched();
        return group.get('PlannedStartTime').setErrors({ range: true });
      }
      if (group.get('PlannedStartTime').hasError('range')) {
        group.get('PlannedStartTime').setErrors({ range: null });
        group.get('PlannedStartTime').updateValueAndValidity();
      }
    };
  }

  timeRangeValid(start, end): boolean {
    if (start && end && start >= end) {
      return false;
    } else {
      return true;
    }
  }

  onDeleteLine(i) {
    if (!this.isManagedCompany) {
      let todelete = this.assignmentsForm.getRawValue()[i];

      if (todelete.Id) {
        this._deletedIds.push(todelete.Id);
      }
      this.assignmentsForm.removeAt(i);
    } else {
      let todelete = this.assignmentsForm.getRawValue()[i]; // check current status saved in DB
      if (todelete.Id && todelete.InitStatus === 'InProgress' || todelete.InitStatus === 'Completed') {
        this.assignmentsForm.at(i).get('Status').patchValue('Cancelled');
        // this._helperService.DialogService.showToastMessage(this._helperService.TranslationService.getTranslation('msgDeleteInprogressOrCompletedAssignment'));
      } else {
        if (todelete.Id) {
          this._deletedIds.push(todelete.Id);
        }
        this.assignmentsForm.removeAt(i);
      }
    }

    if (this.assignmentsForm.getRawValue().length === 0) {
      const disabled = this.isJobInValid;
      this.assignmentsForm.insert(0, this.fb.group(this.createAssignment(disabled), { validators: [this.endTimeValidator()], disabled: true }));
    }

    this.updateView();
  }

  getDeletedIds(): string[] {
    return this._deletedIds;
  }

  addAssignmentClick(index) {
    this.assignmentsForm.insert(++index, this.fb.group(this.createAssignment(), { validators: [this.endTimeValidator()] }));
    this.assignmentsForm.at(index).get('Resource')
      .patchValue(this.assignmentsForm.at(index - 1).get('Resource').value, { emitEvent: false });
    this.assignmentsForm.at(index).get('CountOfInterventions')
      .patchValue(this.assignmentsForm.at(index - 1).get('CountOfInterventions').value, { emitEvent: false });
    this.assignmentsForm.at(index).get('PlannedWorkload')
      .patchValue(this.assignmentsForm.at(index - 1).get('PlannedWorkload').value, { emitEvent: false });
    this.assignmentsForm.at(index).get('PlannedStartTime')
      .patchValue(this.assignmentsForm.at(index - 1).get('PlannedStartTime').value, { emitEvent: false });
    this.assignmentsForm.at(index).get('PlannedEndTime')
      .patchValue(this.assignmentsForm.at(index - 1).get('PlannedEndTime').value, { emitEvent: false });
    this.updateView();
  }

  selectedIntervener(): Array<string> {
    return this.assignmentsForm.getRawValue();
  }

  getValueForm(): Array<any> {
    // GF-464 1.58.0): [HS] Management of automatic status change when the Assignment.Status is updated
    // When the Intervention.Status is updated to cancel, not possible or cancelled & replaced, Done, To Invoice, VerifiedOk and ClosedOk, all assignments in Planned/Draft can be cancelled.
    // Use this.formGroups.getRawValue() is able to get 'Status' value where it is disabled    
    // JSON.stringify() format to YYYY-MM-DDT00:00:00.000Z
    let data = JSON.parse(JSON.stringify(this.formGroups.getRawValue()));
    data.assignmentsForm.forEach(c => {
      if (!this.isManagedCompany) { // external company: set resource = interverner contact
        c.Resource = this.resource;
      }

      c.ResourceCompany = this.resourceCompany;
      // GF-409
      c.Status = this.isManagedCompany ? c.Status ? c.Status : AssignmentStatus.Draft : AssignmentStatus.NA;
    });
    return data.assignmentsForm;
  }

  checkDupplicateAssignments(data): boolean {
    let isDuplicate = false;
    // let data = JSON.parse(JSON.stringify(this.formGroups.value.assignmentsForm));
    data.forEach((item, index) => {
      let t = data.find((x, i) => index !== i
        && item.Status !== AssignmentStatus.Cancelled && x.Status !== AssignmentStatus.Cancelled
        && (x.PlannedDate && item.PlannedDate && x.PlannedDate === item.PlannedDate)
        && ((x.Resource && item.Resource && x.Resource.Id === item.Resource.Id)
          || (!x.Resource && !item.Resource)));
      if (t) {
        if (this.checkOverlapTime(this.getRangesTimestamp(item), this.getRangesTimestamp(t))) {
          isDuplicate = true;
          this.assignmentsForm.at(index).get('PlannedDate').markAsTouched();
          this.assignmentsForm.at(index).get('PlannedDate').setErrors({ overlapping: true });
        } else {
          if (this.assignmentsForm.at(index).get('PlannedDate').hasError('overlapping')) {
            this.assignmentsForm.at(index).get('PlannedDate').setErrors({ overlapping: null });
            this.assignmentsForm.at(index).get('PlannedDate').updateValueAndValidity();
          }
        }
      } else {
        if (this.assignmentsForm.at(index).get('PlannedDate').hasError('overlapping')) {
          this.assignmentsForm.at(index).get('PlannedDate').setErrors({ overlapping: null });
          this.assignmentsForm.at(index).get('PlannedDate').updateValueAndValidity();
        }
      }
    });
    return isDuplicate;
  }
  // convert to ranges timestamp
  getRangesTimestamp(assignment: IInterventionAssignments) {
    const start = assignment.PlannedStartTime
      ? this._utilityService.getTimestamp(assignment.PlannedStartTime)
      : assignment.PlannedWorkload && assignment.PlannedEndTime
        ? this._utilityService.getTimestamp(assignment.PlannedEndTime) - assignment.PlannedWorkload * 60 * 60 * 1000
        : this._utilityService.getTimestamp('00:00');

    const end = assignment.PlannedEndTime
      ? this._utilityService.getTimestamp(assignment.PlannedEndTime)
      : assignment.PlannedWorkload && assignment.PlannedStartTime
        ? this._utilityService.getTimestamp(assignment.PlannedStartTime) + assignment.PlannedWorkload * 60 * 60 * 1000
        : this._utilityService.getTimestamp('23:59');

    return { start: start, end: end };
  }

  checkOverlapTime(range1, range2) {
    return (Math.max(range1.start, range2.start) < Math.min(range1.end, range2.end));
  }

  findFieldChanged() {
    this.subWatchChange.next();
    merge(...this.assignmentsForm.controls.map((control: AbstractControl, index: number) =>
      merge(
        control.get('PlannedWorkload').valueChanges
          .pipe(map(value => ({ index: index, value: +value, fieldChanged: 'PlannedWorkload', control: control }))),
        control.get('PlannedStartTime').valueChanges
          .pipe(map(value => ({ index: index, value, fieldChanged: 'PlannedStartTime', control: control }))),
        control.get('PlannedEndTime').valueChanges
          .pipe(map(value => ({ index: index, value, fieldChanged: 'PlannedEndTime', control: control }))),
        control.get('PlannedDate').valueChanges
          .pipe(map(value => ({ index: index, value, fieldChanged: 'PlannedDate', control: control }))),
        control.get('Resource').valueChanges
          .pipe(map(value => ({ index: index, value, fieldChanged: 'Resource', control: control })))
      )
    )).pipe(takeUntil(this.subWatchChange))
      .subscribe(itemChanged => {
        if (this.advancedInterventionPlanning && this.isManagedCompany) {
          this.disableStatusField(itemChanged);
        }
        switch (itemChanged.fieldChanged) {
          case 'Resource':
            if (itemChanged.value) {
              // this.updateHistoryCount(itemChanged);
            } else {
              this.assignmentsForm.at(itemChanged.index).get('CountOfInterventions').patchValue(0);
            }
            break;
          default:
            this.updateRecord(itemChanged);
            break;
        }
      });
  }

  disableStatusField(itemChanged) {
    if (this.assignmentsForm.at(itemChanged.index).get('Resource').value
      && this.assignmentsForm.at(itemChanged.index).get('PlannedDate').value
      && (
        (this.assignmentsForm.at(itemChanged.index).get('PlannedStartTime').value && this.assignmentsForm.at(itemChanged.index).get('PlannedEndTime').value)
        || (this.assignmentsForm.at(itemChanged.index).get('PlannedStartTime').value && this.assignmentsForm.at(itemChanged.index).get('PlannedWorkload').value)
        || (this.assignmentsForm.at(itemChanged.index).get('PlannedEndTime').value && this.assignmentsForm.at(itemChanged.index).get('PlannedWorkload').value)
        || this.assignmentsForm.at(itemChanged.index).get('PlannedWorkload').value
      )) {
      this.assignmentsForm.at(itemChanged.index).get('Status').enable();
      if (!this.assignmentsForm.at(itemChanged.index).get('Status').value
        || this.assignmentsForm.at(itemChanged.index).get('Status').value === AssignmentStatus.Draft) {
        this.assignmentsForm.at(itemChanged.index).get('Status').patchValue(AssignmentStatus.Planned);
      }
    } else {
      // GF-464 1.58.0): [HS] Management of automatic status change when the Assignment.Status is updated
      // When the Intervention.Status is updated to cancel, not possible or cancelled & replaced, Done, To Invoice, VerifiedOk and ClosedOk, all assignments in Planned/Draft can be cancelled.
      if (this.assignmentsForm.at(itemChanged.index).get('Status').value !== AssignmentStatus.Cancelled)
        this.assignmentsForm.at(itemChanged.index).get('Status').patchValue(AssignmentStatus.Draft);

      this.assignmentsForm.at(itemChanged.index).get('Status').disable();
    }
  }

  updateRecord(itemChanged) {
    /**
     * GF-502: rule:
     *  when the StartTime or Workload is updated, we should recompute the EndTime accordingly (if possible).
        when the Endtime is updated, we should recompute the Workload accordingly (if possible)
          In other words, the StartTime is never recomputed automatically.
          By default, we recompute the End Time unless the Endtime is updated, then we recompute the Workload.

        If the field EndTime is erased, we should recompute the EndTime based on the field Start Time + Workload
        If the field StartTime is erased, we should recompute the StartTime based on the field End Time - Workload
        If the field Workload is erased, we should recompute the Workload based on the field End Time - Start time
     */
    switch (itemChanged.fieldChanged) {
      case 'PlannedWorkload':
        // console.log('---PlannedWorkload changed ', itemChanged);    
        if (itemChanged.value) {
          if ((itemChanged.control.get('PlannedStartTime').value || itemChanged.control.get('PlannedStartTime').value === 0)) {
            const value = this._utilityService
              .computeEndTimeFromDurationAndStartTime(itemChanged.value || 0, itemChanged.control.get('PlannedStartTime').value);
            this.setValueInFormArray(itemChanged.index, 'PlannedEndTime', value ? value : '23:59');

            return;
          }
        } else {
          if (itemChanged.control.get('PlannedStartTime').value && itemChanged.control.get('PlannedEndTime').value) {
            const value = this._utilityService
              .getDuration(itemChanged.control.get('PlannedStartTime').value, itemChanged.control.get('PlannedEndTime').value);
            this.setValueInFormArray(itemChanged.index, 'PlannedWorkload', value > 0 ? value : null);
            return;
          }
        }

        break;
      case 'PlannedStartTime':
        if (itemChanged.value) {
          if ((itemChanged.control.get('PlannedWorkload').value || itemChanged.control.get('PlannedWorkload').value === 0)) {
            const value = this._utilityService
              .computeEndTimeFromDurationAndStartTime(+itemChanged.control.get('PlannedWorkload').value, itemChanged.value || 0);
            this.setValueInFormArray(itemChanged.index, 'PlannedEndTime', value ? value : '23:59');
            return;
          }
        } else {
          // console.log('---start time erased');          
          if ((itemChanged.control.get('PlannedEndTime').value) &&
            (itemChanged.control.get('PlannedWorkload').value || itemChanged.control.get('PlannedWorkload').value === 0)) {
            const value = this._utilityService
              .computeStartTimeFromDurationAndEndTime(+itemChanged.control.get('PlannedWorkload').value, itemChanged.control.get('PlannedEndTime').value);

            this.setValueInFormArray(itemChanged.index, 'PlannedStartTime', value ? value : '23:59');
          }
        }

        break;
      case 'PlannedEndTime':
        console.log('itemChanged.value changed = ', itemChanged.value);

        if (itemChanged.value) {
          if ((itemChanged.control.get('PlannedStartTime').value)) {
            const value = this._utilityService
              .getDuration(itemChanged.control.get('PlannedStartTime').value, itemChanged.value);
            this.setValueInFormArray(itemChanged.index, 'PlannedWorkload', value > 0 ? value : null);
            return;
          }
        } else {
          // console.log('---end time erased');          
          if ((itemChanged.control.get('PlannedStartTime').value) &&
            (itemChanged.control.get('PlannedWorkload').value || itemChanged.control.get('PlannedWorkload').value === 0)) {
            const value = this._utilityService
              .computeEndTimeFromDurationAndStartTime(itemChanged.control.get('PlannedWorkload').value, itemChanged.control.get('PlannedStartTime').value);
            this.setValueInFormArray(itemChanged.index, 'PlannedEndTime', value ? value : '23:59');
            return;
          }
        }
        break;
    }
  }

  setValueInFormArray(index, fieldName, value) {
    let control = this.formGroups.get('assignmentsForm') as FormArray;
    control
      .at(+index)
      .get(fieldName)
      .setValue(value, { emitEvent: false });
    this.updateView();
  }

  getInterveners($event: IDropdownGetDataEvent) {
    if (!this.resourceCompany) {
      const observable = of({
        Count: 0,
        ListItems: []
      });
      return observable.subscribe(x => {
        $event.callBack.next(x);
        $event.callBack.complete();
      });
    }
    let query = {
      FromIndex: $event.startIndex,
      Query: $event.searchText,
      PageSize: $event.pageSize,
      SiteId: this.site.Id,
      CompanyId: this.resourceCompany.Id,
      ProjectId: !!this.project ? this.project.Id : null
    };
    return this._listService.getListWithPost('hs/Intervention/Input/Intervener', query)
      .subscribe((x: any) => {
        $event.callBack.next(x);
        $event.callBack.complete();
      }, (err) => {
        $event.callBack.error(err);
        $event.callBack.complete();
      });
  }

  expandRow(element: IInterventionAssignments) {
    this.expandedElement = this.expandedElement && this.expandedElement === element ? null : element;
  }

  private mouseDownUpCoordinates() {
    let currentPossition: number = 0; // expect 0 & _whiddenEl
    let indexCurrentRow: number;
    let direction: 'right' | 'left';
    const getCoords = pipe(
      map((r: { e: TouchEvent, i: number }) => {
        // e.preventDefault();
        return { clientX: r.e.changedTouches[0].clientX, clientY: r.e.changedTouches[0].clientY, index: r.i };
      })
    );
    const documentEvent = (eventName: string) =>
      merge(...this.elementRow.toArray().map((e, i) => {
        return fromEvent<TouchEvent>(e.nativeElement, eventName).pipe(
          map(r => {
            return {
              e: r,
              i: e.nativeElement.id
            }
          })
        )
      })).pipe(getCoords);

    documentEvent('touchstart').pipe(
      mergeMap(x => {
        const elIndex = this.elementRow.toArray().findIndex(r => r.nativeElement.id == x.index)
        currentPossition = +this.elementRow.toArray()[elIndex].nativeElement.getAttribute('possition') || 0;
        return documentEvent('touchmove').pipe(
          map(y => [x, y]),
          takeUntil(merge(
            documentEvent('touchstart'),
            documentEvent('touchend')
          ).pipe(tap(() => {
            if(direction) {
              if (direction === 'right') {
                if (currentPossition > this._whiddenEl / 2) { // user swipe haft distance
                  currentPossition = this._whiddenEl;
                } else {
                  currentPossition = 0;
                }
              } else {
                if (this._whiddenEl - currentPossition >= this._whiddenEl / 2) { // user swipe haft distance
                  currentPossition = 0;
                } else {
                  currentPossition = this._whiddenEl;
                }
              }
              direction = undefined;
              this.buildAnimation(currentPossition, '200ms ease-in', indexCurrentRow);
            }
          })))
        )
      })
    ).subscribe(([start, end]: [{ clientX: number, clientY: number, index: number }, { clientX: number, clientY: number, index: number }]) => {
      const xDiff = start.clientX - end.clientX;
      const yDiff = start.clientY - end.clientY;
      if (Math.abs(xDiff) > Math.abs(yDiff)) {
        if (xDiff > 0) {
          // correct possition when switch direction
          if(direction === 'left') {
            currentPossition = this._whiddenEl;
         }
          direction = 'right';
          if (xDiff <= this._whiddenEl && currentPossition < this._whiddenEl) {
            currentPossition = xDiff;
            currentPossition = currentPossition < this._whiddenEl ? currentPossition : this._whiddenEl;
          }
        } else {
          if(direction === 'right') {
             currentPossition = 0;
          }
          if(currentPossition != 0) {
            direction = 'left';
            currentPossition = this._whiddenEl - Math.abs(xDiff);
            currentPossition = currentPossition > 0 ? currentPossition : 0;
          }
        }
        // reset direction at start and end position
        // using in case swipe outside element
        if(currentPossition === 0 || currentPossition === this._whiddenEl) {
          direction = undefined;
        }
        indexCurrentRow = start.index;
        this.buildAnimation(currentPossition, '0ms ease-in', indexCurrentRow);
      }
    });
  }
  private buildAnimation(offset: number, timing: string, index: number) {
    const myAnimation: AnimationFactory = this.builder.build([
      animate(timing, style({ transform: `translateX(-${offset}px)` })),
    ]);
    if (index) {
      const elIndex = this.elementRow.toArray().findIndex(r => r.nativeElement.id == index)
      this.elementRow.toArray()[elIndex].nativeElement.setAttribute('possition', offset);
      this.player = myAnimation.create(this.elementRow.toArray()[elIndex].nativeElement);
      this.player.play();
    }
  }

}
