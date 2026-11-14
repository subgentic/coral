package board

import (
 "context"
 "testing"
 "github.com/stretchr/testify/assert"
 "github.com/stretchr/testify/require"
)
func TestRejectedTaskDoesNotReopenGoal16046(t *testing.T) {
 s:=testStore(t);ctx:=context.Background();g:=newGoal(t,s,"team","Finished")
 _,_,err:=s.CloseGoal(ctx,"team",g.ID,"finished",GoalDone);require.NoError(t,err)
 _,err=s.CreateTaskWithOpts(ctx,"team","Invalid dependency","","medium","Lead",&CreateTaskOpts{GoalID:&g.ID,BlockedBy:[]TaskDep{{TaskID:99999}}});require.Error(t,err)
 got,err:=s.GetGoal(ctx,"team",g.ID);require.NoError(t,err);assert.Equal(t,GoalDone,got.State)
}
